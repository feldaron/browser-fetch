import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const CHROME_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const FIREFOX_EXTENSION_ID = process.env.BROWSEC_FIREFOX_EXTENSION_ID ?? "browsec@browsec.com";

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
  if (!response.ok) {
    throw new Error(`Unable to download Browsec CRX: HTTP ${response.status}`);
  }
  const crx = Buffer.from(await response.arrayBuffer());
  if (crx.length < 1_000) throw new Error("Downloaded Browsec CRX is unexpectedly small.");
  await writeFile(crxPath, crx);
  console.log(`Downloaded official Browsec Chrome package (${crx.length} bytes).`);
} else {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

// Firefox 154 no longer allows the old privileged resource:// Services import from
// a WebDriver executeScript call. Chrome 151 can also render extension subresource
// errors inside a successfully loaded extension page. Apply these narrow runtime
// compatibility fixes without weakening the fail-closed public-IP verification.
const runtimeSourcePath = new URL("./prepare-private-vpn-runtime.mjs", import.meta.url);
let runtimeSource = await readFile(runtimeSourcePath, "utf8");

runtimeSource = runtimeSource.replace(
  /async function resolveFirefoxExtensionUuid\(driver\) \{[\s\S]*?\n\}\n\nfunction popupUrl\(\)/,
  `async function resolveFirefoxExtensionUuid(driver) {
  const capabilities = await driver.getCapabilities();
  const runtimeProfile = capabilities.get("moz:profile");
  if (!runtimeProfile || typeof runtimeProfile !== "string") {
    throw new Error("Firefox WebDriver did not report its runtime profile path.");
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const extensions = JSON.parse(await readFile(path.join(runtimeProfile, "extensions.json"), "utf8"));
      const addon = extensions?.addons?.find((entry) => entry?.id === FIREFOX_EXTENSION_ID);
      const rootUri = addon?.rootURI ?? addon?.rootUri;
      if (typeof rootUri === "string" && rootUri.startsWith("moz-extension://")) {
        firefoxExtensionUuid = new URL(rootUri).hostname;
        if (firefoxExtensionUuid) {
          console.log(\`Resolved Firefox Browsec runtime UUID from profile: \${firefoxExtensionUuid}\`);
          return;
        }
      }

      const prefs = await readFile(path.join(runtimeProfile, "prefs.js"), "utf8").catch(() => "");
      const marker = 'user_pref("extensions.webextensions.uuids", ';
      const line = prefs.split("\\n").find((candidate) => candidate.startsWith(marker));
      if (line) {
        const encoded = line.slice(marker.length).replace(/;\\s*$/, "").trim();
        const decoded = JSON.parse(encoded);
        const uuids = JSON.parse(decoded);
        if (typeof uuids?.[FIREFOX_EXTENSION_ID] === "string") {
          firefoxExtensionUuid = uuids[FIREFOX_EXTENSION_ID];
          console.log(\`Resolved Firefox Browsec runtime UUID from prefs: \${firefoxExtensionUuid}\`);
          return;
        }
      }
    } catch {
      // Firefox may still be flushing extension metadata to the profile.
    }
    await sleep(500);
  }

  throw new Error("Firefox did not expose Browsec's runtime extension UUID in its profile.");
}

function popupUrl()`,
);

runtimeSource = runtimeSource.replace(
  `      const current = await driver.getCurrentUrl();\n      const text = await bodyText(driver);\n      if (/ERR_BLOCKED_BY_CLIENT|has been blocked by Chrome/i.test(text)) {\n        throw new Error("Chrome reports the extension page is blocked/unavailable.");\n      }\n      if (current.startsWith(target)) return;`,
  `      const current = await driver.getCurrentUrl();\n      if (current.startsWith(target)) return;\n      const text = await bodyText(driver);\n      if (/ERR_BLOCKED_BY_CLIENT|has been blocked by Chrome/i.test(text)) {\n        throw new Error("Chrome reports the extension page is blocked/unavailable.");\n      }`,
);

// Keep the generated module next to the source module so createRequire(import.meta.url)
// resolves selenium-webdriver from this repository's node_modules rather than /tmp.
const patchedRuntimeUrl = new URL("./.prepare-private-vpn-runtime.patched.mjs", import.meta.url);
await writeFile(patchedRuntimeUrl, runtimeSource, "utf8");
await import(`${patchedRuntimeUrl.href}?run=${Date.now()}`);
