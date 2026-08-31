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
const FIREFOX_EXTENSION_ID = process.env.BROWSEC_FIREFOX_EXTENSION_ID ?? "browsec@browsec.com";
const FIREFOX_EXTENSION_UUID = process.env.BROWSEC_FIREFOX_EXTENSION_UUID ??
  "7f03c0f8-43b5-45c1-a581-d8d5bf7f2d61";
const VPN_COUNTRY = (process.env.PRIVATE_BROWSER_VPN_COUNTRY ?? "uk").toLowerCase();

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}
if (!/^[a-z]{2}$/.test(VPN_COUNTRY)) {
  throw new Error(`Invalid Browsec country code: ${VPN_COUNTRY}`);
}

const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ??
  (browserName === "firefox" ? "firefox" : "google-chrome");
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, browserName);
const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ??
  "/tmp/private-browser/downloads";
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ??
  "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const firefoxXpiPath = process.env.PRIVATE_BROWSER_FIREFOX_VPN_XPI ??
  path.join(profileRoot, "firefox", "extensions", `${FIREFOX_EXTENSION_ID}.xpi`);

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
    // Plain-text endpoints are handled below.
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
      // Try another independent endpoint.
    }
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
}

async function bodyText(driver) {
  try {
    return await driver.findElement(By.css("body")).getText();
  } catch {
    return "";
  }
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
      await sleep(400);
      const ip = extractIp(await bodyText(driver));
      if (ip) {
        await driver.close().catch(() => {});
        if (original) await driver.switchTo().window(original).catch(() => {});
        return ip;
      }
    } catch {
      // Try the next endpoint.
    }
    if (opened) await driver.close().catch(() => {});
    if (original) await driver.switchTo().window(original).catch(() => {});
  }
  return undefined;
}

async function waitForChangedIp(driver, baseline, attempts = 18) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughBrowser(driver).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(1_000);
  }
  return latest;
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

async function seedFirefoxUuidPreference() {
  const uuidMap = JSON.stringify({ [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID });
  const prefsPath = path.join(profileDirectory, "prefs.js");
  let existing = "";
  try {
    existing = await readFile(prefsPath, "utf8");
  } catch {
    // Fresh profile.
  }
  const filtered = existing
    .split("\n")
    .filter((line) => !line.startsWith('user_pref("extensions.webextensions.uuids"'))
    .join("\n")
    .trimEnd();
  const value = JSON.stringify(uuidMap);
  await writeFile(
    prefsPath,
    `${filtered ? `${filtered}\n` : ""}user_pref("extensions.webextensions.uuids", ${value});\n`,
    "utf8",
  );
}

async function buildFirefoxDriver() {
  await seedFirefoxUuidPreference();
  const options = new firefox.Options()
    .setBinary(executable)
    .setProfile(profileDirectory)
    .setPreference("browser.shell.checkDefaultBrowser", false)
    .setPreference("browser.download.dir", downloadDirectory)
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.download.useDownloadDir", true)
    .setPreference("extensions.autoDisableScopes", 0)
    .setPreference("extensions.enabledScopes", 15);

  return new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();
}

async function openFirefoxExtensionPage(driver) {
  const target = `moz-extension://${FIREFOX_EXTENSION_UUID}/popup/popup.html`;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      await driver.get(target);
      await sleep(500);
      const current = await driver.getCurrentUrl();
      const text = await bodyText(driver);
      if (current.startsWith(target) && !/problem loading page|unable to connect|not found/i.test(text)) {
        return;
      }
    } catch {
      // The add-on may still be registering.
    }
    if (attempt === 5) {
      try {
        const installedId = await driver.installAddon(firefoxXpiPath, false);
        if (installedId !== FIREFOX_EXTENSION_ID) {
          throw new Error(`Unexpected Firefox Browsec add-on ID: ${installedId}`);
        }
      } catch (error) {
        console.log(`Firefox add-on install retry: ${error.message}`);
      }
    }
    await sleep(750);
  }
  throw new Error("Firefox could not open Browsec's extension page using the seeded UUID.");
}

async function activateFirefoxStorage(driver) {
  await openFirefoxExtensionPage(driver);
  const result = await driver.executeAsyncScript(`
    const country = arguments[0];
    const done = arguments[arguments.length - 1];
    (async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      if (!api?.storage?.local) throw new Error('extension storage API unavailable');
      const state = await api.storage.local.get('userPac');
      const current = state?.userPac && typeof state.userPac === 'object' ? state.userPac : {};
      const next = {
        ...current,
        mode: 'proxy',
        country,
        broken: false,
        filters: Array.isArray(current.filters) ? current.filters : [],
      };
      await api.storage.local.set({ userPac: next });
      done({ ok: true, mode: next.mode, country: next.country, filters: next.filters.length });
    })().catch((error) => done({ ok: false, error: String(error?.message ?? error) }));
  `, VPN_COUNTRY);
  if (!result?.ok) {
    throw new Error(`Firefox could not persist Browsec proxy state: ${result?.error ?? "unknown error"}`);
  }
  console.log(`Browsec Firefox state saved: ${JSON.stringify(result)}`);
}

async function buildChromeDriver() {
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

async function getChromeDebuggerAddress(driver) {
  const capabilities = await driver.getCapabilities();
  const chromeOptions = capabilities.get("goog:chromeOptions");
  const debuggerAddress = chromeOptions?.debuggerAddress;
  if (!debuggerAddress || typeof debuggerAddress !== "string") {
    throw new Error("ChromeDriver did not expose its DevTools debugger address.");
  }
  return debuggerAddress;
}

async function listChromeDevToolsTargets(debuggerAddress) {
  const response = await fetch(`http://${debuggerAddress}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Chrome DevTools target list returned HTTP ${response.status}.`);
  return response.json();
}

async function findBrowsecChromeTarget(driver) {
  const debuggerAddress = await getChromeDebuggerAddress(driver);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt % 8 === 0) {
      await driver.get("https://example.com/").catch(() => {});
      await sleep(400);
    }
    try {
      const targets = await listChromeDevToolsTargets(debuggerAddress);
      const target = targets.find((entry) =>
        typeof entry?.url === "string" &&
        entry.url.startsWith(`chrome-extension://${CHROME_EXTENSION_ID}/`) &&
        typeof entry.webSocketDebuggerUrl === "string"
      );
      if (target) return target;
    } catch {
      // Chrome may still be applying the managed extension policy.
    }
    await sleep(1_000);
  }
  throw new Error("Chrome did not expose Browsec's managed extension service worker to DevTools.");
}

async function evaluateDevToolsTarget(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error("Timed out evaluating Browsec's Chrome service worker."));
    }, 15_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      if (message.error) {
        reject(new Error(`Chrome DevTools error: ${message.error.message}`));
        return;
      }
      if (message.result?.exceptionDetails) {
        reject(new Error(`Browsec service-worker evaluation failed: ${message.result.exceptionDetails.text}`));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Unable to connect to Browsec's Chrome service worker."));
    });
  });
}

async function activateChromeStorage(driver) {
  const target = await findBrowsecChromeTarget(driver);
  const expression = `
    (async () => {
      const result = await chrome.storage.local.get('userPac');
      const current = result && result.userPac && typeof result.userPac === 'object'
        ? result.userPac
        : {};
      const next = {
        ...current,
        mode: 'proxy',
        country: ${JSON.stringify(VPN_COUNTRY)},
        broken: false,
        filters: Array.isArray(current.filters) ? current.filters : [],
      };
      await chrome.storage.local.set({ userPac: next });
      return { ok: true, mode: next.mode, country: next.country, filters: next.filters.length };
    })()
  `;
  const result = await evaluateDevToolsTarget(target.webSocketDebuggerUrl, expression);
  if (!result?.ok) throw new Error("Chrome could not persist Browsec proxy state.");
  console.log(`Browsec Chrome state saved: ${JSON.stringify(result)}`);
}

async function provisionState() {
  if (browserName === "firefox") {
    const driver = await buildFirefoxDriver();
    try {
      await activateFirefoxStorage(driver);
      await persistFirefoxRuntimeProfile(driver);
    } finally {
      await driver.quit().catch(() => {});
    }
    return;
  }

  const driver = await buildChromeDriver();
  try {
    await activateChromeStorage(driver);
  } finally {
    await driver.quit().catch(() => {});
  }
}

async function buildDriverForVerification() {
  return browserName === "firefox" ? buildFirefoxDriver() : buildChromeDriver();
}

async function verifyChangedIp(baseline, label) {
  const driver = await buildDriverForVerification();
  try {
    const ip = await waitForChangedIp(driver, baseline, 20);
    if (!ip || ip === baseline) {
      throw new Error(`${PROVIDER} did not change the browser public IP during ${label}.`);
    }
    if (browserName === "firefox") await persistFirefoxRuntimeProfile(driver);
    return ip;
  } finally {
    await driver.quit().catch(() => {});
  }
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

await provisionState();
const vpnIp = await verifyChangedIp(baselineIp, "first verified restart");
console.log(`${PROVIDER} changed the browser public IP to ${vpnIp}.`);
const restartIp = await verifyChangedIp(baselineIp, "persistence restart");

await writeFile(
  statusPath,
  `${JSON.stringify({
    provider: PROVIDER,
    browser: browserName,
    country: VPN_COUNTRY,
    verified: true,
    restartVerified: true,
    baselineIp,
    vpnIp,
    restartIp,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

console.log(`${PROVIDER} is active and restart-persistent in ${browserName}: ${baselineIp} -> ${restartIp}`);
