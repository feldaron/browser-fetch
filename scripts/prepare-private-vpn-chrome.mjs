import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const PROVIDER = "Browsec";
const EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const VPN_COUNTRY = (process.env.PRIVATE_BROWSER_VPN_COUNTRY ?? "uk").toLowerCase();
const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, "chrome");
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const devToolsActivePortPath = path.join(profileDirectory, "DevToolsActivePort");
const extensionInstallRoot = path.join(profileDirectory, "Default", "Extensions", EXTENSION_ID);
const ACCEPTED_SHOWN_KEY = "startup terms and conditions accepted shown";
const ACCEPT_PHASE_KEY = "First start accept terms and conditions: phase";

if (!/^[a-z]{2,3}$/.test(VPN_COUNTRY)) {
  throw new Error(`Invalid Browsec country code: ${VPN_COUNTRY}`);
}

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
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
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/9.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const ip = extractIp(await response.text());
      if (ip) return ip;
    } catch {}
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out opening Chrome DevTools websocket.")),
        8_000,
      );
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Unable to open Chrome DevTools websocket."));
        },
        { once: true },
      );
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Chrome DevTools command failed."));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  command(method, params = {}, timeoutMs = 8_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out running Chrome DevTools command ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

async function readDevToolsPort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [portText] = (await readFile(devToolsActivePortPath, "utf8"))
        .trim()
        .split(/\r?\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {}
    await sleep(150);
  }
  throw new Error("Normal Chrome did not expose a DevTools port.");
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}.`);
  return response.json();
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`Chrome could not create target ${url}: HTTP ${response.status}.`);
  return response.json();
}

async function closeTarget(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(4_000),
  }).catch(() => {});
}

async function evaluate(target, expression, { awaitPromise = false, timeoutMs = 8_000 } = {}) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no DevTools websocket URL.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const result = await client.command(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Chrome target evaluation failed.";
      throw new Error(detail);
    }
    return result.result?.value;
  } finally {
    client.close();
  }
}

async function launchNormalChrome() {
  await rm(devToolsActivePortPath, { force: true }).catch(() => {});
  const browser = spawn(
    executable,
    [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1600,1000",
      "about:blank",
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  browser.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 30_000) stderr = stderr.slice(-30_000);
  });

  try {
    const port = await readDevToolsPort();
    return { browser, port, getStderr: () => stderr };
  } catch (error) {
    browser.kill("SIGTERM");
    throw new Error(`${error.message}\n${stderr}`);
  }
}

async function stopChrome(session) {
  if (!session?.browser) return;
  try {
    const version = await fetch(`http://127.0.0.1:${session.port}/json/version`, {
      signal: AbortSignal.timeout(4_000),
    }).then((response) => response.json());
    if (version.webSocketDebuggerUrl) {
      const client = new CdpClient(version.webSocketDebuggerUrl);
      await client.connect();
      await client.command("Browser.close", {}, 4_000).catch(() => {});
      client.close();
    }
  } catch {
    session.browser.kill("SIGTERM");
  }

  await Promise.race([
    new Promise((resolve) => session.browser.once("exit", resolve)),
    sleep(4_000),
  ]);
  if (session.browser.exitCode === null) session.browser.kill("SIGKILL");
  await sleep(500);
}

async function resolveManagedExtension() {
  let lastDetail = "extension directory not created";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const entries = (await readdir(extensionInstallRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      lastDetail = entries.length
        ? `versions found: ${entries.join(", ")}`
        : "extension directory is empty";

      for (const version of entries) {
        try {
          const manifestPath = path.join(extensionInstallRoot, version, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          const popupPath = manifest?.action?.default_popup ?? manifest?.browser_action?.default_popup;
          const workerPath = manifest?.background?.service_worker;
          if (typeof workerPath !== "string" || !workerPath.trim()) {
            lastDetail = `Browsec ${manifest?.version ?? version} has no MV3 service worker`;
            continue;
          }
          return {
            version: String(manifest.version ?? version),
            manifestVersion: manifest.manifest_version,
            popupPath: typeof popupPath === "string" ? popupPath.replace(/^\/+/, "") : null,
            popupUrl: typeof popupPath === "string"
              ? `chrome-extension://${EXTENSION_ID}/${popupPath.replace(/^\/+/, "")}`
              : null,
            workerPath: workerPath.replace(/^\/+/, ""),
            workerUrl: `chrome-extension://${EXTENSION_ID}/${workerPath.replace(/^\/+/, "")}`,
          };
        } catch (error) {
          lastDetail = `could not read installed manifest: ${error?.message ?? error}`;
        }
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`Managed Browsec was not ready in the Chrome profile after 30 seconds (${lastDetail}).`);
}

async function findServiceWorker(port, extensionInfo) {
  const targets = await listTargets(port).catch(() => []);
  return targets.find(
    (target) => target.type === "service_worker" && target.url === extensionInfo.workerUrl,
  ) ?? targets.find(
    (target) => target.type === "service_worker" &&
      target.url?.startsWith(`chrome-extension://${EXTENSION_ID}/`),
  );
}

async function wakeServiceWorker(port, extensionInfo) {
  let lastTargets = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const target = await findServiceWorker(port, extensionInfo);
    if (target) return target;

    lastTargets = await listTargets(port).catch(() => []);
    if (extensionInfo.popupUrl && attempt % 5 === 0) {
      let popup;
      try {
        popup = await createTarget(port, extensionInfo.popupUrl);
        await sleep(400);
      } catch {}
      if (popup?.id) await closeTarget(port, popup.id);
    }
    await sleep(400);
  }

  const summary = lastTargets
    .filter((target) => target.url?.includes(EXTENSION_ID) || target.type === "service_worker")
    .map((target) => `${target.type}:${target.url}`)
    .join(", ");
  throw new Error(`Browsec service worker did not start. Seen targets: ${summary || "none"}.`);
}

async function evaluateWorker(port, extensionInfo, expression, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const worker = await wakeServiceWorker(port, extensionInfo);
      return await evaluate(worker, expression, { awaitPromise: true, ...options });
    } catch (error) {
      lastError = error;
      await sleep(350);
    }
  }
  throw lastError ?? new Error("Unable to evaluate Browsec service worker.");
}

async function acceptStartupConditions(port, extensionInfo) {
  const result = await evaluateWorker(
    port,
    extensionInfo,
    `(async () => {
      await chrome.storage.local.set({
        ${JSON.stringify(ACCEPTED_SHOWN_KEY)}: true,
        ${JSON.stringify(ACCEPT_PHASE_KEY)}: 2
      });
      const saved = await chrome.storage.local.get([
        ${JSON.stringify(ACCEPTED_SHOWN_KEY)},
        ${JSON.stringify(ACCEPT_PHASE_KEY)}
      ]);
      return {
        shown: saved[${JSON.stringify(ACCEPTED_SHOWN_KEY)}] === true,
        phase: saved[${JSON.stringify(ACCEPT_PHASE_KEY)}]
      };
    })()`,
  );
  if (!result?.shown || result?.phase !== 2) {
    throw new Error(`Browsec startup conditions were not persisted: ${JSON.stringify(result)}`);
  }
  console.log(`Browsec startup conditions accepted: ${JSON.stringify(result)}`);
}

async function readBrowsecReadiness(port, extensionInfo) {
  return evaluateWorker(
    port,
    extensionInfo,
    `(async () => {
      const data = await chrome.storage.local.get([
        'serversObject', 'userPac', 'lowLevelPac', 'account'
      ]);
      const countries = data.serversObject?.countries ?? {};
      const requested = countries[${JSON.stringify(VPN_COUNTRY)}] ?? null;
      const freeServers = Array.isArray(requested?.servers) ? requested.servers.length : 0;
      const availableFreeCountries = Object.entries(countries)
        .filter(([, value]) => Array.isArray(value?.servers) && value.servers.length > 0)
        .map(([country]) => country)
        .sort();
      return {
        hasServersObject: Boolean(data.serversObject),
        freeServers,
        availableFreeCountries,
        userPac: data.userPac ?? null,
        lowLevelPac: data.lowLevelPac ?? null,
        accountType: data.account?.type ?? null
      };
    })()`,
  );
}

async function waitForUkServerReadiness(port, extensionInfo) {
  let latest;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    latest = await readBrowsecReadiness(port, extensionInfo).catch(() => undefined);
    if (latest?.freeServers > 0 && latest?.userPac && Array.isArray(latest.userPac.filters)) {
      console.log(`Browsec UK free servers ready: ${JSON.stringify({
        freeServers: latest.freeServers,
        availableFreeCountries: latest.availableFreeCountries,
        accountType: latest.accountType,
      })}`);
      return latest;
    }
    await sleep(500);
  }
  throw new Error(
    `Browsec did not expose a usable ${VPN_COUNTRY} free server list before activation: ${JSON.stringify(latest ?? {})}`,
  );
}

async function enableBrowsec(port, extensionInfo) {
  const result = await evaluateWorker(
    port,
    extensionInfo,
    `(async () => {
      const data = await chrome.storage.local.get(['userPac']);
      const current = data.userPac;
      if (!current || typeof current !== 'object' || !Array.isArray(current.filters)) {
        throw new Error('Browsec userPac is not initialized');
      }
      const next = {
        ...current,
        mode: 'proxy',
        country: ${JSON.stringify(VPN_COUNTRY)},
        filters: current.filters
      };
      await chrome.storage.local.set({ userPac: next });
      return next;
    })()`,
  );
  if (result?.mode !== "proxy" || result?.country !== VPN_COUNTRY) {
    throw new Error(`Browsec rejected requested proxy state: ${JSON.stringify(result)}`);
  }
  console.log(`Browsec userPac enabled through service worker: ${JSON.stringify(result)}`);
}

async function readAppliedProxyState(port, extensionInfo) {
  return evaluateWorker(
    port,
    extensionInfo,
    `(async () => {
      const data = await chrome.storage.local.get(['lowLevelPac', 'userPac']);
      const low = data.lowLevelPac ?? null;
      let proxySetting = null;
      try {
        proxySetting = await chrome.proxy.settings.get({ incognito: false });
      } catch (error) {
        proxySetting = { error: String(error?.message ?? error) };
      }
      const countryServers = Array.isArray(low?.countries?.[${JSON.stringify(VPN_COUNTRY)}])
        ? low.countries[${JSON.stringify(VPN_COUNTRY)}].length
        : 0;
      return {
        userPac: data.userPac ?? null,
        globalReturn: low?.globalReturn ?? null,
        countryServers,
        proxyLevel: proxySetting?.levelOfControl ?? null,
        proxyMode: proxySetting?.value?.mode ?? null,
        proxyError: proxySetting?.error ?? null
      };
    })()`,
  );
}

async function waitForAppliedProxy(port, extensionInfo) {
  let latest;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await readAppliedProxyState(port, extensionInfo).catch(() => undefined);
    if (
      latest?.userPac?.mode === "proxy" &&
      latest?.userPac?.country === VPN_COUNTRY &&
      latest?.globalReturn === VPN_COUNTRY &&
      latest?.countryServers > 0 &&
      ["controllable_by_this_extension", "controlled_by_this_extension"].includes(latest?.proxyLevel)
    ) {
      console.log(`Browsec Chrome proxy applied: ${JSON.stringify(latest)}`);
      return latest;
    }
    await sleep(400);
  }
  throw new Error(`Browsec did not apply its Chrome PAC after activation: ${JSON.stringify(latest ?? {})}`);
}

async function fetchIpThroughChrome(port) {
  for (const endpoint of [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ]) {
    let target;
    try {
      target = await createTarget(port, endpoint);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await sleep(300);
        const value = await evaluate(
          target,
          "document.body ? document.body.innerText : ''",
          { timeoutMs: 3_000 },
        ).catch(() => "");
        const ip = extractIp(value);
        if (ip) return ip;
      }
    } catch {} finally {
      if (target?.id) await closeTarget(port, target.id);
    }
  }
  return undefined;
}

async function waitForChangedIp(port, baseline, attempts = 6) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughChrome(port).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(500);
  }
  return latest;
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

let session = await launchNormalChrome();
let vpnIp;
let extensionInfo;
let appliedProxy;
try {
  extensionInfo = await resolveManagedExtension();
  console.log(`Managed Browsec installed: ${JSON.stringify(extensionInfo)}`);
  await wakeServiceWorker(session.port, extensionInfo);
  await acceptStartupConditions(session.port, extensionInfo);
  await waitForUkServerReadiness(session.port, extensionInfo);
  await enableBrowsec(session.port, extensionInfo);
  appliedProxy = await waitForAppliedProxy(session.port, extensionInfo);
  vpnIp = await waitForChangedIp(session.port, baselineIp, 6);
  if (!vpnIp || vpnIp === baselineIp) {
    throw new Error(`${PROVIDER} applied its Chrome proxy state but did not change the browser public IP.`);
  }
  console.log(`${PROVIDER} changed the managed normal Chrome public IP to ${vpnIp}.`);
} finally {
  await stopChrome(session);
}

session = await launchNormalChrome();
let restartIp;
let restartProxy;
try {
  const restartedExtension = await resolveManagedExtension();
  await wakeServiceWorker(session.port, restartedExtension);
  restartProxy = await waitForAppliedProxy(session.port, restartedExtension);
  restartIp = await waitForChangedIp(session.port, baselineIp, 6);
  if (!restartIp || restartIp === baselineIp) {
    throw new Error(`${PROVIDER} did not remain active after a normal Chrome restart.`);
  }
  console.log(`${PROVIDER} remained active after normal Chrome restart: ${restartIp}.`);
} finally {
  await stopChrome(session);
}

await writeFile(
  statusPath,
  `${JSON.stringify({
    provider: PROVIDER,
    browser: "chrome",
    country: VPN_COUNTRY,
    verified: true,
    restartVerified: true,
    extensionId: EXTENSION_ID,
    extensionVersion: extensionInfo.version,
    baselineIp,
    vpnIp,
    restartIp,
    proxyLevel: appliedProxy?.proxyLevel ?? null,
    restartProxyLevel: restartProxy?.proxyLevel ?? null,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

console.log(`${PROVIDER} is active and restart-persistent in Chrome: ${baselineIp} -> ${restartIp}`);
