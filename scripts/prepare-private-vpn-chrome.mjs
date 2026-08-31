import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const PROVIDER = "Browsec";
const EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh";
const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ?? "google-chrome";
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, "chrome");
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ?? "/tmp/private-browser/vpn-status.json";
const diagnosticsDirectory = path.dirname(statusPath);
const devToolsActivePortPath = path.join(profileDirectory, "DevToolsActivePort");

await Promise.all([mkdir(profileDirectory, { recursive: true }), mkdir(diagnosticsDirectory, { recursive: true })]);

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
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/7.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const ip = extractIp(await response.text());
      if (ip) return ip;
    } catch {}
  }
  throw new Error("Unable to determine the runner public IP before enabling the VPN.");
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

async function evaluate(target, expression) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no DevTools websocket URL.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const result = await client.command("Runtime.evaluate", { expression, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Chrome target evaluation failed.");
    return result.result?.value;
  } finally { client.close(); }
}

async function launchNormalChrome() {
  await rm(devToolsActivePortPath, { force: true }).catch(() => {});
  const browser = spawn(executable, [
    `--user-data-dir=${profileDirectory}`,
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

const acceptTermsExpression = `(() => {
  const nodes=[]; const visit=(root)=>{for(const e of root.querySelectorAll('*')){nodes.push(e);if(e.shadowRoot)visit(e.shadowRoot)}}; visit(document);
  const label=(e)=>[e.innerText,e.textContent,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('value')].filter(Boolean).join(' ').replace(/\\s+/g,' ').trim();
  const text=nodes.map(label).join(' '); if(!/(terms|privacy policy|privacy notice|consent)/i.test(text)) return {relevant:false};
  let toggled=0; for(const e of nodes){const type=e.getAttribute('type'),role=e.getAttribute('role'),tag=e.tagName.toLowerCase();const toggle=type==='checkbox'||role==='checkbox'||role==='switch'||tag==='c-switch';if(!toggle)continue;const checked=(type==='checkbox'&&'checked'in e)?Boolean(e.checked):e.getAttribute('aria-checked')==='true'||/(^|[\\s_-])(on|active|checked|enabled)([\\s_-]|$)/i.test(String(e.className||''));if(!checked){e.click();toggled++}}
  const accept=nodes.find((e)=>{const t=label(e);const clickable=['BUTTON','A','LABEL','INPUT'].includes(e.tagName)||['button','link'].includes(e.getAttribute('role'));return clickable&&/^(accept|agree|continue|confirm)(\\b|\\s|$)/i.test(t)});
  if(accept&&!accept.disabled&&accept.getAttribute('aria-disabled')!=='true'){accept.click();return {relevant:true,clicked:true,toggled}} return {relevant:true,clicked:false,toggled};
})()`;

const activationExpression = `(() => {
  const nodes=[]; const visit=(root)=>{for(const e of root.querySelectorAll('*')){nodes.push(e);if(e.shadowRoot)visit(e.shadowRoot)}}; visit(document);
  const label=(e)=>[e.innerText,e.textContent,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('value')].filter(Boolean).join(' ').replace(/\\s+/g,' ').trim();
  const action=nodes.find((e)=>{const t=label(e);const clickable=['BUTTON','A','LABEL','INPUT'].includes(e.tagName)||['button','link'].includes(e.getAttribute('role'));return clickable&&/^(start vpn|protect me|turn on|connect)(\\b|\\s|$)/i.test(t)});if(action){action.click();return {clicked:true,control:'text',label:label(action)}}
  const sw=nodes.filter((e)=>e.tagName.toLowerCase()==='c-switch'||e.getAttribute('role')==='switch').at(-1);if(sw){sw.click();return {clicked:true,control:'switch',label:label(sw)}}
  const off=nodes.find((e)=>/^off$/i.test(label(e)));if(off){off.click();return {clicked:true,control:'off-label',label:label(off)}} return {clicked:false};
})()`;

async function acceptTermsEverywhere(port) {
  for (const target of await listTargets(port).catch(() => [])) {
    if (!target.webSocketDebuggerUrl) continue;
    if (!target.url?.startsWith(`chrome-extension://${EXTENSION_ID}/`) && !/https?:\/\/([^.]+\.)*browsec\.com\//i.test(target.url ?? "")) continue;
    await evaluate(target, acceptTermsExpression).catch(() => {});
  }
}

async function openPopup(port) {
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await acceptTermsEverywhere(port);
    let target;
    try {
      target = await createTarget(port, popupUrl);
      await sleep(600);
      const href = await evaluate(target, "location.href");
      const text = await evaluate(target, "document.body ? document.body.innerText : ''");
      if (typeof href === "string" && href.startsWith(popupUrl) && !/ERR_BLOCKED_BY_CLIENT|not found|problem loading page/i.test(String(text))) return target;
    } catch (error) { lastError = error; }
    if (target?.id) await closeTarget(port, target.id);
    await sleep(1_000);
  }
  throw lastError ?? new Error("The managed Browsec extension did not become available in normal Chrome.");
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

async function waitForChangedIp(port, baseline, attempts = 15) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchIpThroughChrome(port).catch(() => undefined);
    if (latest && latest !== baseline) return latest;
    await sleep(1_000);
  }
  return latest;
}

async function activateBrowsec(session, baselineIp) {
  for (let cycle = 0; cycle < 6; cycle += 1) {
    await acceptTermsEverywhere(session.port);
    let popup = await openPopup(session.port);
    await evaluate(popup, acceptTermsExpression).catch(() => {});
    await sleep(800);
    if (popup.id) await closeTarget(session.port, popup.id);
    const alreadyChanged = await waitForChangedIp(session.port, baselineIp, 2);
    if (alreadyChanged && alreadyChanged !== baselineIp) return alreadyChanged;
    popup = await openPopup(session.port);
    const result = await evaluate(popup, activationExpression).catch(() => ({ clicked: false }));
    console.log(`${PROVIDER} managed-extension activation: ${JSON.stringify(result)}`);
    if (popup.id) await closeTarget(session.port, popup.id);
    await sleep(1_500);
    const changed = await waitForChangedIp(session.port, baselineIp, 5);
    if (changed && changed !== baselineIp) return changed;
  }
  return undefined;
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);
let session = await launchNormalChrome();
let vpnIp;
try {
  vpnIp = await activateBrowsec(session, baselineIp);
  if (!vpnIp || vpnIp === baselineIp) throw new Error(`${PROVIDER} did not change the managed normal Chrome public IP.`);
  console.log(`${PROVIDER} changed the managed normal Chrome public IP to ${vpnIp}.`);
} finally { await stopChrome(session); }

session = await launchNormalChrome();
let restartIp;
try {
  restartIp = await waitForChangedIp(session.port, baselineIp, 18);
  if (!restartIp || restartIp === baselineIp) throw new Error(`${PROVIDER} did not remain active after a normal Chrome restart.`);
  console.log(`${PROVIDER} remained active after normal Chrome restart: ${restartIp}.`);
} finally { await stopChrome(session); }

await writeFile(statusPath, `${JSON.stringify({provider:PROVIDER,browser:"chrome",verified:true,restartVerified:true,extensionId:EXTENSION_ID,baselineIp,vpnIp,restartIp,verifiedAt:new Date().toISOString()}, null, 2)}\n`, "utf8");
console.log(`${PROVIDER} is active and restart-persistent in chrome: ${baselineIp} -> ${restartIp}`);
