import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Builder, By } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const PROVIDER = "Browsec";
const EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, "chrome");
const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ?? "/tmp/private-browser/downloads";
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(downloadDirectory, { recursive: true }),
  mkdir(path.dirname(statusPath), { recursive: true }),
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractIp(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    const value = typeof parsed === "string" ? parsed : parsed?.ip;
    if (typeof value === "string" && isIP(value.trim())) return value.trim();
  } catch {}
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
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/11.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const ip = extractIp(await response.text());
      if (ip) return ip;
    } catch {}
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
}

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
  if (!/(terms|privacy policy|privacy notice|consent)/i.test(pageText)) {
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
  if (mode === 'off') {
    const target = nodes.find((element) => /^off$/i.test(label(element)));
    if (target) {
      target.click();
      return { clicked: true, control: 'off-label', label: label(target) };
    }
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

async function acceptTermsEverywhere(driver) {
  const original = await driver.getWindowHandle().catch(() => undefined);
  const handles = await driver.getAllWindowHandles().catch(() => []);
  for (const handle of handles) {
    try {
      await driver.switchTo().window(handle);
      const url = await driver.getCurrentUrl().catch(() => "");
      if (!url.startsWith(`chrome-extension://${EXTENSION_ID}/`) && !/https?:\/\/([^.]+\.)*browsec\.com\//i.test(url)) continue;
      const result = await driver.executeScript(acceptTermsScript);
      if (result?.relevant) {
        console.log(`Browsec first-run acceptance: ${JSON.stringify(result)}`);
        await sleep(700);
      }
    } catch {}
  }
  const remaining = await driver.getAllWindowHandles().catch(() => []);
  if (original && remaining.includes(original)) {
    await driver.switchTo().window(original).catch(() => {});
  } else if (remaining.length) {
    await driver.switchTo().window(remaining[0]).catch(() => {});
  }
}

async function openPopup(driver) {
  const target = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await acceptTermsEverywhere(driver);
    try {
      await driver.get(target);
      await sleep(500);
      const current = await driver.getCurrentUrl();
      const text = await bodyText(driver);
      if (/ERR_BLOCKED_BY_CLIENT|has been blocked by Chrome|not found/i.test(text)) {
        throw new Error("Chrome reports the managed Browsec popup is unavailable.");
      }
      if (current.startsWith(target)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error("The managed Browsec extension did not become available in Chrome.");
}

async function fetchIpThroughBrowser(driver) {
  const original = await driver.getWindowHandle().catch(() => undefined);
  for (const endpoint of [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ]) {
    let opened = false;
    try {
      await driver.switchTo().newWindow("tab");
      opened = true;
      await driver.get(endpoint);
      await sleep(300);
      const ip = extractIp(await bodyText(driver));
      if (ip) {
        await driver.close().catch(() => {});
        if (original) await driver.switchTo().window(original).catch(() => {});
        return ip;
      }
    } catch {}
    if (opened) await driver.close().catch(() => {});
    if (original) await driver.switchTo().window(original).catch(() => {});
  }
  return undefined;
}

async function waitForChangedIp(driver, baseline, attempts = 6) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughBrowser(driver).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(600);
  }
  return latest;
}

async function activateAndVerify(driver, baseline) {
  await acceptTermsEverywhere(driver);
  await openPopup(driver);
  await acceptTermsEverywhere(driver);
  await openPopup(driver);
  const alreadyChanged = await waitForChangedIp(driver, baseline, 2);
  if (alreadyChanged && alreadyChanged !== baseline) return alreadyChanged;
  for (const mode of ["text", "c-switch", "role-switch", "off"]) {
    await openPopup(driver);
    const result = await driver.executeScript(activationScript, mode)
      .catch((error) => ({ clicked: false, control: mode, error: String(error?.message ?? error) }));
    console.log(`${PROVIDER} activation via ${mode}: ${JSON.stringify(result)}`);
    await sleep(1_200);
    const changed = await waitForChangedIp(driver, baseline, 4);
    if (changed && changed !== baseline) return changed;
  }
  return undefined;
}

async function buildDriver() {
  const options = new chrome.Options()
    .setChromeBinaryPath(executable)
    .addArguments(
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1600,1000",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
    );
  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
  await driver.manage().setTimeouts({ pageLoad: 8_000, script: 8_000 });
  return driver;
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

let driver = await buildDriver();
let vpnIp;
try {
  vpnIp = await activateAndVerify(driver, baselineIp);
  if (!vpnIp || vpnIp === baselineIp) {
    throw new Error(`${PROVIDER} did not change the managed Chrome public IP.`);
  }
  console.log(`${PROVIDER} changed the managed Chrome public IP to ${vpnIp}.`);
} finally {
  await driver.quit().catch(() => {});
}

driver = await buildDriver();
let restartIp;
try {
  await openPopup(driver);
  restartIp = await waitForChangedIp(driver, baselineIp, 8);
  if (!restartIp || restartIp === baselineIp) {
    throw new Error(`${PROVIDER} did not remain active after a normal Chrome restart.`);
  }
  console.log(`${PROVIDER} remained active after normal Chrome restart: ${restartIp}.`);
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
    extensionId: EXTENSION_ID,
    baselineIp,
    vpnIp,
    restartIp,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

console.log(`${PROVIDER} is active and restart-persistent in Chrome: ${baselineIp} -> ${restartIp}`);
