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
  const ACCEPTED_SHOWN_KEY = "startup terms and conditions accepted shown";
  const ACCEPT_PHASE_KEY = "First start accept terms and conditions: phase";

  if (!/^[a-z]{2,3}$/.test(VPN_COUNTRY)) {
    throw new Error(`Invalid Browsec country code: ${VPN_COUNTRY}`);
  }

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
          headers: { "user-agent": "LaptopValue-private-browser-vpn-check/10.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) continue;
        const ip = extractIp(await response.text());
        if (ip) return ip;
      } catch {}
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
    ]) {
      let opened = false;
      try {
        await driver.switchTo().newWindow("tab");
        opened = true;
        await driver.get(endpoint);
        await sleep(250);
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

  async function waitForChangedIp(driver, baseline, attempts = 4) {
    let latest;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await fetchIpThroughBrowser(driver).catch(() => undefined);
      if (latest && latest !== baseline) return latest;
      await sleep(500);
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

    await driver.manage().setTimeouts({ pageLoad: 5_000, script: 45_000 });

    if (!restart) {
      await readFile(firefoxXpiPath).catch(() => {
        throw new Error(`Firefox Browsec XPI is missing at ${firefoxXpiPath}.`);
      });
      const installedId = await driver.installAddon(firefoxXpiPath, false);
      if (installedId !== FIREFOX_EXTENSION_ID) {
        throw new Error(`Unexpected Firefox Browsec add-on ID: ${installedId}`);
      }
      await sleep(1_000);
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

      await sleep(200);
    }
    throw new Error("Firefox did not persist Browsec's runtime moz-extension UUID in its profile.");
  }

  async function prepareAndActivateBrowsec(driver) {
    console.log("Preparing Browsec through Firefox native extension storage.");
    await driver.setContext("chrome");
    let result;
    try {
      result = await driver.executeAsyncScript(`
        const extensionId = arguments[0];
        const country = arguments[1];
        const acceptedShownKey = arguments[2];
        const acceptPhaseKey = arguments[3];
        const done = arguments[arguments.length - 1];

        (async () => {
          const { ExtensionParent } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs'
          );
          const { ExtensionStorage } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionStorage.sys.mjs'
          );
          const { ExtensionStorageIDB } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionStorageIDB.sys.mjs'
          );

          let extension;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            extension = ExtensionParent.GlobalManager.getExtension(extensionId);
            if (extension) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (!extension) throw new Error('Browsec extension is not active in Firefox');

          const selected = await ExtensionStorageIDB.selectBackend({ extension });
          let db = null;
          let backend;

          const getKey = async (key) => {
            if (selected.backendEnabled) return (await db.get(key))?.[key];
            return ExtensionStorage.get(extension.id, key);
          };

          const setValues = async (values) => {
            if (selected.backendEnabled) {
              const changes = await db.set(values);
              if (changes) ExtensionStorageIDB.notifyListeners(extension.id, changes);
              return;
            }
            await ExtensionStorage.set(extension.id, values);
          };

          if (selected.backendEnabled) {
            const storagePrincipal = ExtensionStorageIDB.getStoragePrincipal(extension);
            db = await ExtensionStorageIDB.open(
              storagePrincipal,
              extension.hasPermission('unlimitedStorage')
            );
            backend = 'IndexedDB';
          } else {
            backend = 'JSONFile';
          }

          try {
            await setValues({
              [acceptedShownKey]: true,
              [acceptPhaseKey]: 2
            });

            const stored = await getKey('userPac');
            const current = stored && typeof stored === 'object' && Array.isArray(stored.filters)
              ? stored
              : { mode: 'direct', country: null, broken: false, filters: [] };
            const next = {
              ...current,
              mode: 'proxy',
              country,
              broken: false,
              filters: current.filters
            };
            await setValues({ userPac: next });

            let applied = null;
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const low = await getKey('lowLevelPac');
              const storedPac = await getKey('userPac');
              const countryServers = Array.isArray(low?.countries?.[country])
                ? low.countries[country].length
                : 0;
              applied = {
                mode: storedPac?.mode ?? null,
                country: storedPac?.country ?? null,
                globalReturn: low?.globalReturn ?? null,
                countryServers
              };
              if (
                applied.mode === 'proxy' &&
                applied.country === country &&
                applied.globalReturn === country &&
                applied.countryServers > 0
              ) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }

            if (
              applied?.mode !== 'proxy' ||
              applied?.country !== country ||
              applied?.globalReturn !== country ||
              !(applied?.countryServers > 0)
            ) {
              throw new Error('Browsec did not generate a usable low-level PAC: ' + JSON.stringify(applied));
            }

            return { backend, defaultedUserPac: stored == null, applied };
          } finally {
            db?.close?.();
          }
        })()
          .then((value) => done({ ok: true, ...value }))
          .catch((error) => done({
            ok: false,
            error: String(error?.message ?? error),
            stack: String(error?.stack ?? '')
          }));
      `, FIREFOX_EXTENSION_ID, VPN_COUNTRY, ACCEPTED_SHOWN_KEY, ACCEPT_PHASE_KEY);
    } finally {
      await driver.setContext("content").catch(() => {});
    }

    if (!result?.ok) {
      throw new Error(
        `Firefox could not prepare Browsec: ${result?.error ?? "unknown error"}` +
        (result?.stack ? `\n${result.stack}` : ""),
      );
    }

    console.log(`Browsec Firefox prepared: ${JSON.stringify(result)}`);
    return result;
  }

  async function readPersistedProxyState(driver) {
    await driver.setContext("chrome");
    let result;
    try {
      result = await driver.executeAsyncScript(`
        const extensionId = arguments[0];
        const country = arguments[1];
        const done = arguments[arguments.length - 1];
        (async () => {
          const { ExtensionParent } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs'
          );
          const { ExtensionStorage } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionStorage.sys.mjs'
          );
          const { ExtensionStorageIDB } = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionStorageIDB.sys.mjs'
          );
          let extension;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            extension = ExtensionParent.GlobalManager.getExtension(extensionId);
            if (extension) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (!extension) throw new Error('Browsec extension is not active after Firefox restart');

          const selected = await ExtensionStorageIDB.selectBackend({ extension });
          let db = null;
          if (selected.backendEnabled) {
            const principal = ExtensionStorageIDB.getStoragePrincipal(extension);
            db = await ExtensionStorageIDB.open(principal, extension.hasPermission('unlimitedStorage'));
          }
          try {
            const getKey = async (key) => selected.backendEnabled
              ? (await db.get(key))?.[key]
              : ExtensionStorage.get(extension.id, key);
            const userPac = await getKey('userPac');
            const low = await getKey('lowLevelPac');
            return {
              mode: userPac?.mode ?? null,
              country: userPac?.country ?? null,
              globalReturn: low?.globalReturn ?? null,
              countryServers: Array.isArray(low?.countries?.[country])
                ? low.countries[country].length
                : 0
            };
          } finally {
            db?.close?.();
          }
        })()
          .then((value) => done({ ok: true, ...value }))
          .catch((error) => done({ ok: false, error: String(error?.message ?? error) }));
      `, FIREFOX_EXTENSION_ID, VPN_COUNTRY);
    } finally {
      await driver.setContext("content").catch(() => {});
    }

    if (!result?.ok) {
      throw new Error(`Unable to inspect Browsec after Firefox restart: ${result?.error ?? "unknown error"}`);
    }
    return result;
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
  let applied;
  try {
    const uuid = await resolveFirefoxExtensionUuid(driver);
    console.log(`Resolved Firefox Browsec runtime UUID: ${uuid}`);
    applied = await prepareAndActivateBrowsec(driver);
    vpnIp = await waitForChangedIp(driver, baselineIp, 4);
    if (!vpnIp || vpnIp === baselineIp) {
      throw new Error(`${PROVIDER} generated a Firefox PAC but did not change the browser public IP.`);
    }
    console.log(`${PROVIDER} changed the Firefox public IP to ${vpnIp}.`);
    await persistRuntimeProfile(driver);
  } finally {
    await driver.quit().catch(() => {});
  }

  driver = await buildDriver({ restart: true });
  let restartIp;
  let restartState;
  try {
    restartState = await readPersistedProxyState(driver);
    if (
      restartState.mode !== "proxy" ||
      restartState.country !== VPN_COUNTRY ||
      restartState.globalReturn !== VPN_COUNTRY ||
      !(restartState.countryServers > 0)
    ) {
      throw new Error(`${PROVIDER} proxy state did not survive Firefox restart: ${JSON.stringify(restartState)}`);
    }
    restartIp = await waitForChangedIp(driver, baselineIp, 4);
    if (!restartIp || restartIp === baselineIp) {
      throw new Error(`${PROVIDER} did not remain active after a Firefox restart.`);
    }
    await persistRuntimeProfile(driver);
  } finally {
    await driver.quit().catch(() => {});
  }

  await writeFile(
    statusPath,
    `${JSON.stringify({
      provider: PROVIDER,
      browser: "firefox",
      country: VPN_COUNTRY,
      verified: true,
      restartVerified: true,
      baselineIp,
      vpnIp,
      restartIp,
      storageBackend: applied?.backend ?? null,
      restartState,
      verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(`${PROVIDER} is active and restart-persistent in Firefox: ${baselineIp} -> ${restartIp}`);
}
