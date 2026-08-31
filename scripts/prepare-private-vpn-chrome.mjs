import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const PROVIDER = "Browsec";
const STORE_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const VPN_COUNTRY = (process.env.PRIVATE_BROWSER_VPN_COUNTRY ?? "uk").toLowerCase();
const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, "chrome");
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const crxPath = path.join(diagnosticsDirectory, "browsec-chrome.crx");
const zipPath = path.join(diagnosticsDirectory, "browsec-chrome.zip");
const unpackedDirectory = path.join(diagnosticsDirectory, "browsec-chrome-unpacked");
const devToolsActivePortPath = path.join(profileDirectory, "DevToolsActivePort");

if (!/^[a-z]{2}$/.test(VPN_COUNTRY)) throw new Error(`Invalid Browsec country code: ${VPN_COUNTRY}`);

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(diagnosticsDirectory, { recursive: true }),
]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  for (const endpoint of ["https://api.ipify.org?format=json", "https://ifconfig.co/ip", "https://icanhazip.com/"]) {
    try {
      const response = await fetch(endpoint, {
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/6.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const ip = extractIp(await response.text());
      if (ip) return ip;
    } catch {}
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
}

async function downloadAndUnpackOfficialExtension() {
  const versionProcess = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let versionText = "";
  versionProcess.stdout?.on("data", (chunk) => { versionText += String(chunk); });
  versionProcess.stderr?.on("data", (chunk) => { versionText += String(chunk); });
  await new Promise((resolve, reject) => {
    versionProcess.once("error", reject);
    versionProcess.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Chrome --version exited ${code}`)));
  });
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

  const unzip = spawn("unzip", ["-q", "-o", zipPath, "-d", unpackedDirectory], { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    unzip.once("error", reject);
    unzip.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)));
  });
  JSON.parse(await readFile(path.join(unpackedDirectory, "manifest.json"), "utf8"));
  console.log(`Downloaded and unpacked official Browsec Chrome package (${crx.length} bytes).`);
}

class CdpClient {
  constructor(url) { this.url = url; this.socket = null; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening Chrome DevTools websocket.")), 10_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Unable to open Chrome DevTools websocket.")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Chrome DevTools command failed."));
      else pending.resolve(message.result ?? {});
    });
  }
  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out running Chrome DevTools command ${method}.`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.socket?.close(); } catch {} }
}

async function readDevToolsPort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [portText] = (await readFile(devToolsActivePortPath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {}
    await sleep(200);
  }
  throw new Error("Normal Chrome did not expose a DevTools port.");
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}.`);
  return response.json();
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Chrome could not create target ${url}: HTTP ${response.status}.`);
  return response.json();
}

async function closeTarget(port, id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
}

async function evaluate(target, expression, awaitPromise = false) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no DevTools websocket URL.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const result = await client.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      userGesture: true,
      awaitPromise,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Chrome target evaluation failed.");
    return result.result?.value;
  } finally { client.close(); }
}

async function launchNormalChrome() {
  await rm(devToolsActivePortPath, { force: true }).catch(() => {});
  const browser = spawn(executable, [
    `--user-data-dir=${profileDirectory}`,
    `--load-extension=${unpackedDirectory}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1600,1000",
    "about:blank",
  ], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr?.on("data", (chunk) => { stderr += String(chunk); if (stderr.length > 30_000) stderr = stderr.slice(-30_000); });
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
    const version = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
    if (version.webSocketDebuggerUrl) {
      const client = new CdpClient(version.webSocketDebuggerUrl);
      await client.connect();
      await client.command("Browser.close").catch(() => {});
      client.close();
    }
  } catch { session.browser.kill("SIGTERM"); }
  await Promise.race([new Promise((resolve) => session.browser.once("exit", resolve)), sleep(5_000)]);
  if (session.browser.exitCode === null) session.browser.kill("SIGKILL");
  await sleep(800);
}

async function resolveExtensionTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const targets = await listTargets(port).catch(() => []);
    const target = targets.find((entry) =>
      typeof entry?.url === "string" &&
      /^chrome-extension:\/\/[^/]+\//.test(entry.url) &&
      typeof entry.webSocketDebuggerUrl === "string"
    );
    if (target) {
      const extensionId = target.url.match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
      if (extensionId) return { target, extensionId };
    }
    await sleep(500);
  }
  throw new Error("Chrome did not expose the loaded Browsec extension target.");
}

async function activateBrowsec(session) {
  const { target, extensionId } = await resolveExtensionTarget(session.port);
  const result = await evaluate(target, `
    (async () => {
      const stored = await chrome.storage.local.get('userPac');
      const current = stored?.userPac && typeof stored.userPac === 'object' ? stored.userPac : {};
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
  `, true);
  if (!result?.ok) throw new Error("Chrome could not persist Browsec proxy state.");
  console.log(`Browsec Chrome proxy state saved for ${extensionId}: ${JSON.stringify(result)}`);
  return extensionId;
}

async function fetchIpThroughChrome(port) {
  for (const endpoint of ["https://api.ipify.org?format=json", "https://ifconfig.co/ip", "https://icanhazip.com/"]) {
    let target;
    try {
      target = await createTarget(port, endpoint);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250);
        const ip = extractIp(await evaluate(target, "document.body ? document.body.innerText : ''").catch(() => ""));
        if (ip) return ip;
      }
    } catch {} finally { if (target?.id) await closeTarget(port, target.id); }
  }
  return undefined;
}

async function waitForChangedIp(port, baseline, attempts = 20) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughChrome(port).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(1_000);
  }
  return latest;
}

await downloadAndUnpackOfficialExtension();
const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

let session = await launchNormalChrome();
let vpnIp;
let extensionId;
try {
  extensionId = await activateBrowsec(session);
  vpnIp = await waitForChangedIp(session.port, baselineIp, 24);
  if (!vpnIp || vpnIp === baselineIp) throw new Error(`${PROVIDER} did not change the normal Chrome public IP.`);
  console.log(`${PROVIDER} changed the normal Chrome public IP to ${vpnIp}.`);
} finally { await stopChrome(session); }

session = await launchNormalChrome();
let restartIp;
try {
  restartIp = await waitForChangedIp(session.port, baselineIp, 24);
  if (!restartIp || restartIp === baselineIp) throw new Error(`${PROVIDER} did not remain active after a normal Chrome restart.`);
  console.log(`${PROVIDER} remained active after normal Chrome restart: ${restartIp}.`);
} finally { await stopChrome(session); }

await writeFile(statusPath, `${JSON.stringify({
  provider: PROVIDER,
  browser: "chrome",
  country: VPN_COUNTRY,
  verified: true,
  restartVerified: true,
  extensionId,
  extensionPath: unpackedDirectory,
  baselineIp,
  vpnIp,
  restartIp,
  verifiedAt: new Date().toISOString(),
}, null, 2)}\n`, "utf8");
console.log(`${PROVIDER} is active and restart-persistent in chrome: ${baselineIp} -> ${restartIp}`);
