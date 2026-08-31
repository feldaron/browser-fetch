import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Builder, By } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const firefox = require("selenium-webdriver/firefox");

const PROVIDER = "Browsec";
const CHROME_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const FIREFOX_EXTENSION_ID = "browsec@browsec.com";
const FIREFOX_EXTENSION_UUID = "8f9b7b1a-6d40-4f5c-a7db-5e8f86f24691";

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ??
  (browserName === "firefox" ? "firefox" : "google-chrome");
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ??
  "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, browserName);
const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ??
  "/tmp/private-browser/downloads";
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ??
  "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const firefoxXpiPath = path.join(
  profileDirectory,
  "extensions",
  `${FIREFOX_EXTENSION_ID}.xpi`,
);

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
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/2.0" },
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

const deepSnapshotScript = `
  const nodes = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll('*')) {
      nodes.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return nodes.slice(0, 250).map((element) => ({
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
  const allText = nodes.map(label).join(' ');
  if (!/(terms|privacy policy)/i.test(allText) || !/(accept|agree|consent|continue)/i.test(allText)) {
    return { found: false, accepted: false, toggled: 0 };
  }

  const accept = nodes.find((element) => {
    const text = label(element);
    const clickable = ['BUTTON', 'A', 'LABEL', 'INPUT'].includes(element.tagName) ||
      ['button', 'link'].includes(element.getAttribute('role'));
    return clickable && /^(accept|agree|continue|confirm)(\\b|\\s)/i.test(text);
  });

  if (accept && !accept.disabled && accept.getAttribute('aria-disabled') !== 'true') {
    accept.click();
    return { found: true, accepted: true, toggled: 0 };
  }

  let toggled = 0;
  for (const element of nodes) {
    const role = element.getAttribute('role');
    const type = element.getAttribute('type');
    const isToggle = type === 'checkbox' || role === 'checkbox' || role === 'switch' ||
      element.tagName.toLowerCase() === 'c-switch';
    if (!isToggle) continue;

    const aria = element.getAttribute('aria-checked');
    const classes = typeof element.className === 'string' ? element.className : '';
    const checked = type === 'checkbox' && 'checked' in element
      ? Boolean(element.checked)
      : aria === 'true' || /(^|[\\s_-])(on|active|checked|enabled)([\\s_-]|$)/i.test(classes);
    if (!checked) {
      element.click();
      toggled += 1;
    }
  }

  const acceptAfter = nodes.find((element) => {
    const text = label(element);
    const clickable = ['BUTTON', 'A', 'LABEL', 'INPUT'].includes(element.tagName) ||
      ['button', 'link'].includes(element.getAttribute('role'));
    return clickable && /^(accept|agree|continue|confirm)(\\b|\\s)/i.test(text);
  });
  if (acceptAfter) acceptAfter.click();
  return { found: true, accepted: Boolean(acceptAfter), toggled };
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

  if (mode === 'custom-switch') {
    const switches = nodes.filter((element) => element.tagName.toLowerCase() === 'c-switch');
    const target = switches.at(-1);
    if (target) {
      const aria = target.getAttribute('aria-checked');
      const classes = typeof target.className === 'string' ? target.className : '';
      const on = aria === 'true' || /(^|[\\s_-])(on|active|checked|enabled)([\\s_-]|$)/i.test(classes);
      if (!on) target.click();
      return { clicked: !on, control: 'c-switch', alreadyOn: on, label: label(target) };
    }
  }

  if (mode === 'semantic-switch') {
    const switches = nodes.filter((element) => element.getAttribute('role') === 'switch');
    const target = switches.at(-1);
    if (target) {
      const on = target.getAttribute('aria-checked') === 'true';
      if (!on) target.click();
      return { clicked: !on, control: 'role-switch', alreadyOn: on, label: label(target) };
    }
  }

  if (mode === 'off') {
    const off = nodes.find((element) => /^off$/i.test(label(element)));
    if (off) {
      off.click();
      return { clicked: true, control: 'off-label', label: label(off) };
    }
  }

  return { clicked: false, control: mode };
`;

async function getBodyText(driver) {
  try {
    return await driver.findElement(By.css("body")).getText();
  } catch {
    return "";
  }
}

async function saveDiagnostics(driver, suffix) {
  const stem = `browsec-${browserName}-${suffix}`;
  let currentUrl = "";
  let source = "";
  let snapshot = [];
  let screenshot = "";
  try { currentUrl = await driver.getCurrentUrl(); } catch {}
  try { source = await driver.getPageSource(); } catch {}
  try { snapshot = await driver.executeScript(deepSnapshotScript); } catch {}
  try { screenshot = await driver.takeScreenshot(); } catch {}

  await Promise.all([
    writeFile(
      path.join(diagnosticsDirectory, `${stem}.txt`),
      `URL: ${currentUrl}\n\nBODY TEXT:\n${await getBodyText(driver)}\n\nDEEP NODES:\n${JSON.stringify(snapshot, null, 2)}\n`,
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
  let changed = false;

  for (const handle of handles) {
    try {
      await driver.switchTo().window(handle);
      const result = await driver.executeScript(acceptTermsScript);
      if (result?.found) {
        changed = true;
        await sleep(700);
      }
    } catch {
      // A first-run page may close itself after acceptance.
    }
  }

  if (original && (await driver.getAllWindowHandles()).includes(original)) {
    await driver.switchTo().window(original).catch(() => {});
  }
  return changed;
}

function popupUrl() {
  return browserName === "firefox"
    ? `moz-extension://${FIREFOX_EXTENSION_UUID}/popup/popup.html`
    : `chrome-extension://${CHROME_EXTENSION_ID}/popup/popup.html`;
}

async function openPopup(driver) {
  const target = popupUrl();
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await acceptTermsEverywhere(driver);
    try {
      await driver.get(target);
      await sleep(700);
      const current = await driver.getCurrentUrl();
      const snapshot = await driver.executeScript(deepSnapshotScript);
      if (current.startsWith(target) && Array.isArray(snapshot) && snapshot.length > 0) {
        return;
      }
    } catch {
      // Managed installs can take a few seconds to become available.
    }
    await sleep(1_000);
  }
  throw new Error(`${PROVIDER} did not become available in ${browserName}.`);
}

async function fetchIpThroughBrowser(driver) {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ];
  const original = await driver.getWindowHandle().catch(() => undefined);

  for (const endpoint of endpoints) {
    let temporary;
    try {
      temporary = await driver.switchTo().newWindow("tab");
      await driver.get(endpoint);
      await sleep(300);
      const ip = extractIp(await getBodyText(driver));
      if (ip) {
        await driver.close().catch(() => {});
        if (original) await driver.switchTo().window(original).catch(() => {});
        return ip;
      }
    } catch {
      // Try another endpoint through the browser/VPN route.
    }

    if (temporary) await driver.close().catch(() => {});
    if (original) await driver.switchTo().window(original).catch(() => {});
  }

  return undefined;
}

async function waitForChangedBrowserIp(driver, baseline, attempts = 12) {
  let latestIp;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(1_000);
    latestIp = await fetchIpThroughBrowser(driver).catch(() => undefined);
    if (latestIp && latestIp !== baseline) return latestIp;
  }
  return latestIp;
}

async function activateAndVerify(driver, baseline) {
  const modes = ["text", "custom-switch", "semantic-switch", "off"];

  for (let attempt = 0; attempt < modes.length; attempt += 1) {
    await acceptTermsEverywhere(driver);
    await openPopup(driver);
    await acceptTermsEverywhere(driver);
    await openPopup(driver);

    const mode = modes[attempt];
    const result = await driver.executeScript(activationScript, mode).catch(() => ({ clicked: false, control: mode }));
    console.log(`${PROVIDER} activation attempt ${attempt + 1}: ${JSON.stringify(result)}`);
    await sleep(1_500);

    const changedIp = await waitForChangedBrowserIp(driver, baseline, 5);
    if (changedIp && changedIp !== baseline) return changedIp;

    await openPopup(driver).catch(() => {});
    await saveDiagnostics(driver, `attempt-${attempt + 1}-${mode}`).catch(() => {});
  }

  return undefined;
}

async function persistFirefoxRuntimeProfile(driver) {
  const capabilities = await driver.getCapabilities();
  const runtimeProfile = capabilities.get("moz:profile");
  if (!runtimeProfile || typeof runtimeProfile !== "string") {
    throw new Error("Firefox WebDriver did not report its runtime profile path.");
  }

  const staging = `${profileDirectory}.persisting`;
  await rm(staging, { recursive: true, force: true });
  await cp(runtimeProfile, staging, { recursive: true });
  await rm(profileDirectory, { recursive: true, force: true });
  await cp(staging, profileDirectory, { recursive: true });
  await rm(staging, { recursive: true, force: true });
}

async function buildDriver({ restart = false } = {}) {
  if (browserName === "chrome") {
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
    return new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();
  }

  const options = new firefox.Options()
    .setBinary(executable)
    .setPreference("browser.shell.checkDefaultBrowser", false)
    .setPreference("browser.download.dir", downloadDirectory)
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.download.useDownloadDir", true)
    .setPreference("extensions.autoDisableScopes", 0)
    .setPreference("extensions.enabledScopes", 15)
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID }),
    );

  if (restart) options.setProfile(profileDirectory);

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  if (!restart) {
    try {
      await readFile(firefoxXpiPath);
    } catch {
      throw new Error(`Firefox Browsec XPI is missing at ${firefoxXpiPath}.`);
    }
    const installedId = await driver.installAddon(firefoxXpiPath, false);
    if (installedId !== FIREFOX_EXTENSION_ID) {
      throw new Error(`Unexpected Firefox Browsec add-on ID: ${installedId}`);
    }
    await sleep(1_500);
  }

  return driver;
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

let driver = await buildDriver();
let vpnIp;
try {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await acceptTermsEverywhere(driver);
    await sleep(400);
  }

  vpnIp = await activateAndVerify(driver, baselineIp);
  if (!vpnIp || vpnIp === baselineIp) {
    await openPopup(driver).catch(() => {});
    await saveDiagnostics(driver, "ip-unchanged").catch(() => {});
    throw new Error(`${PROVIDER} did not change the browser public IP.`);
  }
  console.log(`${PROVIDER} changed the browser public IP to ${vpnIp}.`);

  if (browserName === "firefox") {
    await persistFirefoxRuntimeProfile(driver);
  }
} finally {
  await driver.quit().catch(() => {});
}

driver = await buildDriver({ restart: true });
let restartIp;
try {
  restartIp = await waitForChangedBrowserIp(driver, baselineIp, 12);
  if (!restartIp || restartIp === baselineIp) {
    await openPopup(driver).catch(() => {});
    await saveDiagnostics(driver, "restart-ip-unchanged").catch(() => {});
    throw new Error(`${PROVIDER} did not remain active after a browser restart.`);
  }

  if (browserName === "firefox") {
    await persistFirefoxRuntimeProfile(driver);
  }
} finally {
  await driver.quit().catch(() => {});
}

await writeFile(
  statusPath,
  `${JSON.stringify({
    provider: PROVIDER,
    browser: browserName,
    verified: true,
    restartVerified: true,
    baselineIp,
    vpnIp,
    restartIp,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

console.log(
  `${PROVIDER} is active and restart-persistent in ${browserName}: ` +
  `${baselineIp} -> ${restartIp}`,
);
