import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const CHROME_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const FIREFOX_EXTENSION_ID = process.env.BROWSEC_FIREFOX_EXTENSION_ID ?? "browsec@browsec.com";
const FIREFOX_EXTENSION_UUID = "8f9b7b1a-6d40-4f5c-a7db-5e8f86f24691";

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const diagnosticsDirectory = path.dirname(
  process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json",
);

if (browserName === "firefox") {
  process.env.PRIVATE_BROWSER_FIREFOX_VPN_XPI ??= path.join(
    profileRoot,
    "firefox",
    "extensions",
    `${FIREFOX_EXTENSION_ID}.xpi`,
  );
} else if (browserName === "chrome") {
  const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
  const crxPath = process.env.PRIVATE_BROWSER_CHROME_VPN_CRX ??
    path.join(diagnosticsDirectory, "browsec-chrome.crx");
  process.env.PRIVATE_BROWSER_CHROME_VPN_CRX = crxPath;

  await mkdir(path.dirname(crxPath), { recursive: true });
  const { stdout, stderr } = await execFileAsync(executable, ["--version"]);
  const versionText = `${stdout}\n${stderr}`;
  const version = versionText.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error(`Unable to determine Chrome version from: ${versionText.trim()}`);

  const params = new URLSearchParams({
    response: "redirect",
    prodversion: version,
    acceptformat: "crx2,crx3",
    x: `id=${CHROME_EXTENSION_ID}&uc`,
  });
  const response = await fetch(`https://clients2.google.com/service/update2/crx?${params}`, {
    redirect: "follow",
    headers: { "user-agent": `Mozilla/5.0 Chrome/${version}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to download Browsec CRX: HTTP ${response.status}`);
  const crx = Buffer.from(await response.arrayBuffer());
  if (crx.length < 1_000) throw new Error("Downloaded Browsec CRX is unexpectedly small.");
  await writeFile(crxPath, crx);
  console.log(`Downloaded official Browsec Chrome package (${crx.length} bytes).`);
} else {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

const runtimeSourcePath = new URL("./prepare-private-vpn-runtime.mjs", import.meta.url);
let runtimeSource = await readFile(runtimeSourcePath, "utf8");

// Give Firefox a deterministic moz-extension hostname in the temporary profile.
// That avoids privileged browser-internal APIs, which Firefox 154 no longer exposes
// to WebDriver scripts, while keeping the extension itself official and unmodified.
runtimeSource = runtimeSource.replace(
  /async function resolveFirefoxExtensionUuid\(driver\) \{[\s\S]*?\n\}\n\nfunction popupUrl\(\)/,
  `async function resolveFirefoxExtensionUuid(driver) {
  firefoxExtensionUuid = "${FIREFOX_EXTENSION_UUID}";
  console.log(\`Using configured Firefox Browsec runtime UUID: \${firefoxExtensionUuid}\`);
}

function popupUrl()`,
);
runtimeSource = runtimeSource.replace(
  `.setPreference("extensions.enabledScopes", 15);`,
  `.setPreference("extensions.enabledScopes", 15)\n    .setPreference("extensions.webextensions.uuids", JSON.stringify({\n      [FIREFOX_EXTENSION_ID]: "${FIREFOX_EXTENSION_UUID}",\n    }));`,
);

// ChromeDriver intentionally blocks direct chrome-extension:// navigation even
// when Browsec is installed. Use Chrome's DevTools endpoint to talk to Browsec's
// own service worker instead. We change only Browsec's own local state, then rely
// on Browsec's storage listener to apply its proxy configuration. The external-IP
// gate below remains authoritative: if Browsec does not really route traffic, the
// workflow still fails closed.
const chromeWorkerHelpers = `
async function chromeWorkerEvaluate(driver, expression) {
  const capabilities = await driver.getCapabilities();
  const chromeOptions = capabilities.get("goog:chromeOptions") ?? {};
  const debuggerAddress = chromeOptions.debuggerAddress;
  if (!debuggerAddress) throw new Error("ChromeDriver did not expose a DevTools debugger address.");

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await fetch(\`http://\${debuggerAddress}/json/list\`)
      .then((response) => response.json())
      .catch(() => []);
    const target = targets.find((entry) =>
      ["service_worker", "background_page"].includes(entry.type) &&
      String(entry.url || "").startsWith("chrome-extension://${CHROME_EXTENSION_ID}/") &&
      entry.webSocketDebuggerUrl
    );
    if (!target) {
      await sleep(500);
      continue;
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening Browsec DevTools target.")), 5_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Unable to open Browsec DevTools target.")); }, { once: true });
    });

    try {
      const id = 1;
      const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out evaluating Browsec service worker.")), 10_000);
        const onMessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          if (message.error) reject(new Error(message.error.message || "Browsec DevTools evaluation failed."));
          else resolve(message.result);
        };
        socket.addEventListener("message", onMessage);
      });
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
      const response = await resultPromise;
      const exception = response?.exceptionDetails;
      if (exception) throw new Error(exception.text || "Browsec service-worker evaluation threw.");
      return response?.result?.value;
    } finally {
      socket.close();
    }
  }

  throw new Error("Browsec Chrome service worker did not become available.");
}
`;
runtimeSource = runtimeSource.replace(
  `async function activateAndVerify(driver, baseline) {`,
  `${chromeWorkerHelpers}\nasync function activateAndVerify(driver, baseline) {\n  if (browserName === "chrome") {\n    const result = await chromeWorkerEvaluate(driver, \`new Promise((resolve, reject) => {\n      chrome.storage.local.get(["userPac"], async ({ userPac }) => {\n        try {\n          const current = userPac && typeof userPac === "object"\n            ? userPac\n            : { mode: "direct", country: null, broken: false, filters: [] };\n          const next = {\n            ...current,\n            mode: "proxy",\n            country: current.country || "uk",\n            broken: false,\n            filters: Array.isArray(current.filters) ? current.filters : [],\n          };\n          await chrome.storage.local.set({\n            "startup terms and conditions accepted shown": true,\n            "First start accept terms and conditions: phase": 2,\n            userPac: next,\n          });\n          resolve(next);\n        } catch (error) { reject(error); }\n      });\n    })\`);\n    console.log(\`Browsec Chrome service worker enabled VPN state: \${JSON.stringify(result)}\`);\n    await sleep(3_000);\n    return waitForChangedIp(driver, baseline, 20);\n  }`,
);

const patchedRuntimeUrl = new URL("./.prepare-private-vpn-runtime.patched.mjs", import.meta.url);
await writeFile(patchedRuntimeUrl, runtimeSource, "utf8");
await import(`${patchedRuntimeUrl.href}?run=${Date.now()}`);
