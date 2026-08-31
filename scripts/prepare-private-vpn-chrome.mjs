import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { Builder, By } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const execFileAsync = promisify(execFile);

const PROVIDER = "Browsec";
const STORE_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, "chrome");
const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ?? "/tmp/private-browser/downloads";
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const crxPath = path.join(diagnosticsDirectory, "browsec-chrome.crx");
const zipPath = path.join(diagnosticsDirectory, "browsec-chrome.zip");
const unpackedDirectory = path.join(diagnosticsDirectory, "browsec-chrome-unpacked");
const extensionIdPath = path.join(diagnosticsDirectory, "browsec-chrome-extension-id.txt");

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(downloadDirectory, { recursive: true }),
  mkdir(diagnosticsDirectory, { recursive: true }),
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractIp(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    const value = typeof parsed === "string" ? parsed : parsed?.ip;
    if (typeof value === "string" && isIP(value.trim())) return value.trim();
  } catch {
    // Plain-text IP endpoints are handled below.
  }

  for (const token of trimmed.split(/\s+/)) {
    const candidate = token.replace(/^[^0-9a-f:.]+|[^0-9a-f:.]+$/gi, "");
    if (candidate && isIP(candidate)) return candidate;
  }
  return undefined;
}

async function fetchIpOutsideBrowser() {
  for (const endpoint of [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ]) {
    try {
      const response = await fetch(endpoint, {
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/4.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const ip = extractIp(await response.text());
      if (ip) return ip;
    } catch {
      // Try the next independent IP service.
    }
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
}

async function downloadAndUnpackOfficialExtension() {
  const { stdout, stderr } = await execFileAsync(executable, ["--version"]);
  const versionText = `${stdout}\n${stderr}`;
  const version = versionText.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error(`Unable to determine Chrome version from: ${versionText.trim()}`);

  const params = new URLSearchParams({
    response: "redirect",
    prodversion: version,
    acceptformat: "crx2,crx3",
    x: `id=${STORE_EXTENSION_ID}&uc`,
  });
  const response = await fetch(`https://clients2.google.com/service/update2/crx?${params}`, {
    redirect: "follow",
    headers: { "user-agent": `Mozilla/5.0 Chrome/${version}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to download Browsec CRX: HTTP ${response.status}`);

  const crx = Buffer.from(await response.arrayBuffer());
  const zipOffset = crx.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zipOffset < 0 || crx.length - zipOffset < 1_000) {
    throw new Error("Downloaded Browsec CRX did not contain a valid ZIP payload.");
  }

  await writeFile(crxPath, crx);
  await writeFile(zipPath, crx.subarray(zipOffset));
  await rm(unpackedDirectory, { recursive: true, force: true });
  await mkdir(unpackedDirectory, { recursive: true });
  await execFileAsync("unzip", ["-q", zipPath, "-d", unpackedDirectory]);
  const manifest = JSON.parse(await readFile(path.join(unpackedDirectory, "manifest.json"), "utf8"));
  if (manifest?.version !== undefined && typeof manifest.version !== "string") {
    throw new Error("Browsec manifest is malformed after unpacking.");
  }
  console.log(`Downloaded and unpacked official Browsec Chrome package (${crx.length} bytes).`);
}

async function sendBidiCommand(driver, method, params) {
  const capabilities = await driver.getCapabilities();
  const webSocketUrl = capabilities.get("webSocketUrl");
  if (!webSocketUrl || typeof webSocketUrl !== "string") {
    throw new Error("Chrome did not expose a WebDriver BiDi websocket URL.");
  }

  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening the WebDriver BiDi websocket.")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to open the WebDriver BiDi websocket."));
    }, { once: true });
  });

  const id = Math.floor(Math.random() * 1_000_000_000) + 1;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out running BiDi command ${method}.`)), 30_000);
      const onMessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        if (message.type === "error" || message.error) {
          reject(new Error(`${method} failed: ${message.error ?? "error"}: ${message.message ?? "unknown error"}`));
        } else {
          resolve(message.result ?? message);
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    socket.close();
  }
}

async function installExtensionViaBidi(driver) {
  const result = await sendBidiCommand(driver, "webExtension.install", {
    extensionData: {
      type: "path",
      path: unpackedDirectory,
    },
  });
  const extensionId = result?.extension;
  if (!extensionId || typeof extensionId !== "string") {
    throw new Error(`Chrome BiDi did not return an extension ID: ${JSON.stringify(result)}`);
  }
  await writeFile(extensionIdPath, `${extensionId}\n`, "utf8");
  console.log(`Installed Browsec through WebDriver BiDi as ${extensionId}.`);
  return extensionId;
}

const collectNodesScript = `
  const nodes = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      nodes.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return nodes.slice(0, 350).map((element) => ({
    tag: element.tagName,
    text: String(element.innerText || element.textContent || '').trim().slice(0, 300),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    ariaChecked: element.getAttribute('aria-checked'),
    ariaDisabled: element.getAttribute('aria-disabled'),
    disabled: Boolean(element.disabled),
    type: element.getAttribute('type'),
    value: element.getAttribute('value'),
    className: typeof element.className === 'string' ? element.className : '',
  }));
`;

const acceptTermsScript = `
  const nodes = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      nodes.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  const label = (element) => [
    element.innerText,
    element.textContent,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('value'),
  ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();

  const pageText = nodes.map(label).join(' ');
  if (!/(terms|privacy policy|privacy notice)/i.test(pageText)) {
    return { relevant: false, clicked: false, toggled: 0 };
  }

  let toggled = 0;
  for (const element of nodes) {
    const type = element.getAttribute('type');
    const role = element.getAttribute('role');
    const tag = element.tagName.toLowerCase();
    const toggle = type === 'checkbox' || role === 'checkbox' || role === 'switch' || tag === 'c-switch';
    if (!toggle) continue;
    const checked = type === 'checkbox' && 'checked' in element
      ? Boolean(element.checked)
      : element.getAttribute('aria-checked') === 'true' ||
        /(^|[\\s_-])(on|active|checked|enabled)([\\s_-]|$)/i.test(String(element.className || ''));
    if (!checked) {
      element.click();
      toggled += 1;
    }
  }

  const accept = nodes.find((element) => {
    const text = label(element);
    const clickable = ['BUTTON', 'A', 'LABEL', 'INPUT'].includes(element.tagName) ||
      ['button', 'link'].includes(element.getAttribute('role'));
    return clickable && /^(accept|agree|continue|confirm)(\\b|\\s|$)/i.test(text);
  });
  if (accept && !accept.disabled && accept.getAttribute('aria-disabled') !== 'true') {
    accept.click();
    return { relevant: true, clicked: true, toggled };
  }
  return { relevant: true, clicked: false, toggled };
`;

const activationScript = `
  const mode = arguments[0];
  const nodes = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      nodes.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  const label = (element) => [
    element.innerText,
    element.textContent,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('value'),
  ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();

  if (mode === 'text') {
    const action = nodes.find((element) => {
      const text = label(element);
      const clickable = ['BUTTON', 'A', 'LABEL', 'INPUT'].includes(element.tagName) ||
        ['button', 'link'].includes(element.getAttribute('role'));
      return clickable && /^(start vpn|protect me|turn on|connect)(\\b|\\s|$)/i.test(text);
    });
    if (action) {
      action.click();
      return { clicked: true, control: 'text', label: label(action) };
    }
  }

  if (mode === 'c-switch') {
    const target = nodes.filter((element) => element.tagName.toLowerCase() === 'c-switch').at(-1);
    if (target) {
      target.click();
      return { clicked: true, control: 'c-switch', label: label(target) };
    }
  }

  if (mode === 'role-switch') {
    const target = nodes.filter((element) => element.getAttribute('role') === 'switch').at(-1);
    if (target) {
      target.click();
      return { clicked: true, control: 'role-switch', label: label(target) };
    }
  }

  const off = nodes.find((element) => /^off$/i.test(label(element)));
  if (mode === 'off' && off) {
    off.click();
    return { clicked: true, control: 'off-label', label: label(off) };
  }

  return { clicked: false, control: mode };
`;

async function bodyText(driver) {
  try {
    return await driver.findElement(By.css("body")).getText();
  } catch {
    return "";
  }
}

async function saveDiagnostics(driver, suffix) {
  const stem = `browsec-chrome-${suffix}`;
  let currentUrl = "";
  let source = "";
  let nodes = [];
  let screenshot = "";
  try { currentUrl = await driver.getCurrentUrl(); } catch {}
  try { source = await driver.getPageSource(); } catch {}
  try { nodes = await driver.executeScript(collectNodesScript); } catch {}
  try { screenshot = await driver.takeScreenshot(); } catch {}

  await Promise.all([
    writeFile(
      path.join(diagnosticsDirectory, `${stem}.txt`),
      `URL: ${currentUrl}\n\nBODY TEXT:\n${await bodyText(driver)}\n\nDEEP NODES:\n${JSON.stringify(nodes, null, 2)}\n`,
      "utf8",
    ).catch(() => {}),
    writeFile(path.join(diagnosticsDirectory, `${stem}.html`), source, "utf8").catch(() => {}),
    screenshot
      ? writeFile(path.join(diagnosticsDirectory, `${stem}.png`), screenshot, "base64").catch(() => {})
      : Promise.resolve(),
  ]);
}

async function acceptTermsEverywhere(driver) {
  const original = await driver.getWindowHandle().catch(() => undefined);
  const handles = await driver.getAllWindowHandles().catch(() => []);
  for (const handle of handles) {
    try {
      await driver.switchTo().window(handle);
      const url = await driver.getCurrentUrl().catch(() => "");
      if (!url.startsWith("chrome-extension://") && !/https?:\/\/([^.]+\.)*browsec\.com\//i.test(url)) continue;
      const result = await driver.executeScript(acceptTermsScript);
      if (result?.relevant) await sleep(800);
    } catch {
      // First-run provider pages may close themselves.
    }
  }
  const remaining = await driver.getAllWindowHandles().catch(() => []);
  if (original && remaining.includes(original)) {
    await driver.switchTo().window(original).catch(() => {});
  } else if (remaining.length) {
    await driver.switchTo().window(remaining[0]).catch(() => {});
  }
}

async function openPopup(driver, extensionId) {
  const target = `chrome-extension://${extensionId}/popup/popup.html`;
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await acceptTermsEverywhere(driver);
    try {
      await driver.get(target);
      await sleep(700);
      const current = await driver.getCurrentUrl();
      const text = await bodyText(driver);
      if (/ERR_BLOCKED_BY_CLIENT|has been blocked by Chrome/i.test(text)) {
        throw new Error("Chrome reports the extension page is blocked/unavailable.");
      }
      if (current.startsWith(target)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(750);
  }
  throw lastError ?? new Error(`${PROVIDER} did not become available in Chrome.`);
}

async function fetchIpThroughBrowser(driver) {
  const original = await driver.getWindowHandle().catch(() => undefined);
  for (const endpoint of [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ]) {
    let temporary;
    try {
      temporary = await driver.switchTo().newWindow("tab");
      await driver.get(endpoint);
      await sleep(300);
      const ip = extractIp(await bodyText(driver));
      if (ip) {
        await driver.close().catch(() => {});
        if (original) await driver.switchTo().window(original).catch(() => {});
        return ip;
      }
    } catch {
      // Try another independent IP endpoint.
    }
    if (temporary) await driver.close().catch(() => {});
    if (original) await driver.switchTo().window(original).catch(() => {});
  }
  return undefined;
}

async function waitForChangedIp(driver, baseline, attempts = 8) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughBrowser(driver).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(1_000);
  }
  return latest;
}

async function activateAndVerify(driver, extensionId, baseline) {
  await acceptTermsEverywhere(driver);
  await openPopup(driver, extensionId);
  await acceptTermsEverywhere(driver);
  await openPopup(driver, extensionId);

  const alreadyChanged = await waitForChangedIp(driver, baseline, 2);
  if (alreadyChanged && alreadyChanged !== baseline) return alreadyChanged;

  for (const mode of ["text", "c-switch", "role-switch", "off"]) {
    await openPopup(driver, extensionId);
    const result = await driver.executeScript(activationScript, mode)
      .catch(() => ({ clicked: false, control: mode }));
    console.log(`${PROVIDER} activation via ${mode}: ${JSON.stringify(result)}`);
    await sleep(1_500);

    const changed = await waitForChangedIp(driver, baseline, 5);
    if (changed && changed !== baseline) return changed;

    await openPopup(driver, extensionId).catch(() => {});
    await saveDiagnostics(driver, `activation-${mode}`).catch(() => {});
  }
  return undefined;
}

async function buildDriver({ restart = false } = {}) {
  const options = new chrome.Options()
    .setChromeBinaryPath(executable)
    .addArguments(
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1600,1000",
    );

  if (!restart) {
    options.enableBidi();
    options.addArguments("--remote-debugging-pipe", "--enable-unsafe-extension-debugging");
  }

  return new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
}

await downloadAndUnpackOfficialExtension();
const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

let driver = await buildDriver();
let extensionId;
let vpnIp;
try {
  extensionId = await installExtensionViaBidi(driver);
  vpnIp = await activateAndVerify(driver, extensionId, baselineIp);
  if (!vpnIp || vpnIp === baselineIp) {
    await openPopup(driver, extensionId).catch(() => {});
    await saveDiagnostics(driver, "ip-unchanged").catch(() => {});
    throw new Error(`${PROVIDER} did not change the browser public IP.`);
  }
  console.log(`${PROVIDER} changed the Chrome public IP to ${vpnIp}.`);
} finally {
  await driver.quit().catch(() => {});
}

driver = await buildDriver({ restart: true });
let restartIp;
try {
  extensionId = (await readFile(extensionIdPath, "utf8")).trim();
  await openPopup(driver, extensionId);
  restartIp = await waitForChangedIp(driver, baselineIp, 12);
  if (!restartIp || restartIp === baselineIp) {
    await saveDiagnostics(driver, "restart-ip-unchanged").catch(() => {});
    throw new Error(`${PROVIDER} did not remain active after a normal Chrome restart.`);
  }
} finally {
  await driver.quit().catch(() => {});
}

await writeFile(
  statusPath,
  `${JSON.stringify({
    provider: PROVIDER,
    browser: "chrome",
    verified: true,
    restartVerified: true,
    extensionId,
    baselineIp,
    vpnIp,
    restartIp,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

console.log(`${PROVIDER} is active and restart-persistent in chrome: ${baselineIp} -> ${restartIp}`);
