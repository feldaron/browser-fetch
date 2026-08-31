import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

await import("./prepare-private-vpn-runtime.mjs");
