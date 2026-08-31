import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

if (browserName === "chrome") {
  await import("./prepare-private-vpn-chrome.mjs");
} else {
  const require = createRequire(import.meta.url);
  const { Builder, By } = require("selenium-webdriver");
  const firefox = require("selenium-webdriver/firefox");

  const PROVIDER = "Browsec";
  const FIREFOX_EXTENSION_ID = process.env.BROWSEC_FIREFOX_EXTENSION_ID ?? "browsec@browsec.com";
  const VPN_COUNTRY = (process.env.PRIVATE_BROWSER_VPN_COUNTRY ?? "uk").toLowerCase();
  const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "firefox";
  const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
  const profileDirectory = path.join(profileRoot, "firefox");
  const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ?? "/tmp/private-browser/downloads";
  const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";
  const firefoxXpiPath = process.env.PRIVATE_BROWSER_FIREFOX_VPN_XPI ??
    path.join(profileDirectory, "extensions", `${FIREFOX_EXTENSION_ID}.xpi`);

  if (!/^[a-z]{2}$/.test(VPN_COUNTRY)) throw new Error(`Invalid Browsec country code: ${VPN_COUNTRY}`);

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
          headers: { "user-agent": "LaptopValue-private-browser-vpn-check/4.0" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) continue;
        const ip = extractIp(await response.text());
        if (ip) return ip;
      } catch {}
    }
    throw new Error("Unable to determine the runner public IP before enabling the VPN.");
  }

  async function bodyText(driver) {
    try { return await driver.findElement(By.css("body")).getText(); } catch { return ""; }
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
        await sleep(350);
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

  async function waitForChangedIp(driver, baseline, attempts = 18) {
    let latest;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await fetchIpThroughBrowser(driver).catch(() => undefined);
      if (latest && latest !== baseline) return latest;
      await sleep(1_000);
    }
    return latest;
  }

  async function buildDriver({ restart = false } = {}) {
    const options = new firefox.Options()
      .setBinary(executable)
      .setPreference("browser.shell.checkDefaultBrowser", false)
      .setPreference("browser.download.dir", downloadDirectory)
      .setPreference("browser.download.folderList", 2)
      .setPreference("browser.download.useDownloadDir", true)
      .setPreference("extensions.autoDisableScopes", 0)
      .setPreference("extensions.enabledScopes", 15);
    if (restart) options.setProfile(profileDirectory);

    const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
    const driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build();

    if (!restart) {
      await readFile(firefoxXpiPath).catch(() => {
        throw new Error(`Firefox Browsec XPI is missing at ${firefoxXpiPath}.`);
      });
      const installedId = await driver.installAddon(firefoxXpiPath, false);
      if (installedId !== FIREFOX_EXTENSION_ID) {
        throw new Error(`Unexpected Firefox Browsec add-on ID: ${installedId}`);
      }
      await sleep(1_500);
    }
    return driver;
  }

  async function resolveFirefoxExtensionUuid(driver) {
    const capabilities = await driver.getCapabilities();
    const runtimeProfile = capabilities.get("moz:profile");
    if (!runtimeProfile || typeof runtimeProfile !== "string") {
      throw new Error("Firefox WebDriver did not report its runtime profile path while resolving Browsec.");
    }

    const prefsPath = path.join(runtimeProfile, "prefs.js");
    const extensionsPath = path.join(runtimeProfile, "extensions.json");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const prefs = await readFile(prefsPath, "utf8").catch(() => "");
      const preference = prefs.match(/user_pref\("extensions\.webextensions\.uuids",\s*("(?:\\.|[^"\\])*")\);/);
      if (preference) {
        try {
          const encodedMap = JSON.parse(preference[1]);
          const uuidMap = JSON.parse(encodedMap);
          const uuid = uuidMap?.[FIREFOX_EXTENSION_ID];
          if (typeof uuid === "string" && /^[0-9a-f-]{36}$/i.test(uuid)) return uuid;
        } catch {}
      }

      try {
        const extensions = JSON.parse(await readFile(extensionsPath, "utf8"));
        const addon = extensions?.addons?.find((item) => item?.id === FIREFOX_EXTENSION_ID);
        const rootUri = addon?.rootURI ?? addon?.rootUri;
        const fromRoot = typeof rootUri === "string"
          ? rootUri.match(/^moz-extension:\/\/([0-9a-f-]{36})\//i)?.[1]
          : undefined;
        if (fromRoot) return fromRoot;
      } catch {}

      await sleep(250);
    }
    throw new Error("Firefox did not persist Browsec's runtime moz-extension UUID in its profile.");
  }

  async function openExtensionPage(driver, uuid) {
    const target = `moz-extension://${uuid}/popup/popup.html`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await driver.get(target);
        await sleep(500);
        if ((await driver.getCurrentUrl()).startsWith(target)) return;
      } catch {}
      await sleep(600);
    }
    throw new Error("Firefox could not open Browsec's extension page.");
  }

  async function activateBrowsec(driver, uuid) {
    await openExtensionPage(driver, uuid);
    const result = await driver.executeAsyncScript(`
      const country = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const api = globalThis.browser ?? globalThis.chrome;
        if (!api?.storage?.local) throw new Error('extension storage API unavailable');
        const stored = await api.storage.local.get('userPac');
        const current = stored?.userPac && typeof stored.userPac === 'object' ? stored.userPac : {};
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
    console.log(`Browsec Firefox proxy state saved: ${JSON.stringify(result)}`);
  }

  async function persistRuntimeProfile(driver) {
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

  const baselineIp = await fetchIpOutsideBrowser();
  console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

  let driver = await buildDriver();
  let vpnIp;
  try {
    const uuid = await resolveFirefoxExtensionUuid(driver);
    console.log(`Resolved Firefox Browsec runtime UUID: ${uuid}`);
    await activateBrowsec(driver, uuid);
    vpnIp = await waitForChangedIp(driver, baselineIp, 20);
    if (!vpnIp || vpnIp === baselineIp) {
      throw new Error(`${PROVIDER} did not change the Firefox public IP.`);
    }
    console.log(`${PROVIDER} changed the Firefox public IP to ${vpnIp}.`);
    await persistRuntimeProfile(driver);
  } finally {
    await driver.quit().catch(() => {});
  }

  driver = await buildDriver({ restart: true });
  let restartIp;
  try {
    restartIp = await waitForChangedIp(driver, baselineIp, 20);
    if (!restartIp || restartIp === baselineIp) {
      throw new Error(`${PROVIDER} did not remain active after a Firefox restart.`);
    }
    await persistRuntimeProfile(driver);
  } finally {
    await driver.quit().catch(() => {});
  }

  await writeFile(statusPath, `${JSON.stringify({
    provider: PROVIDER,
    browser: "firefox",
    country: VPN_COUNTRY,
    verified: true,
    restartVerified: true,
    baselineIp,
    vpnIp,
    restartIp,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  console.log(`${PROVIDER} is active and restart-persistent in Firefox: ${baselineIp} -> ${restartIp}`);
}