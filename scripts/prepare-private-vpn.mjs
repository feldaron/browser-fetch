import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { chromium, firefox } from "playwright";

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
const statusPath = process.env.PRIVATE_BROWSER_VPN_STATUS ??
  "/tmp/private-browser/vpn-status.json";

await mkdir(profileDirectory, { recursive: true });
await mkdir(path.dirname(statusPath), { recursive: true });

function extractIp(text) {
  const trimmed = text.trim();

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
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/1.0" },
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

async function bodyText(page) {
  if (page.isClosed()) return "";
  return page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
}

function isBrowsecPage(page) {
  if (page.isClosed()) return false;
  try {
    const url = page.url();
    return url.startsWith("chrome-extension://") ||
      url.startsWith("moz-extension://") ||
      /https?:\/\/([^.]+\.)*browsec\.com\//i.test(url);
  } catch {
    return false;
  }
}

async function acceptTerms(page) {
  if (!isBrowsecPage(page)) return false;

  try {
    const text = await bodyText(page);
    if (!/terms|conditions|privacy|accept|agree|consent/i.test(text)) return false;

    let changed = false;
    const toggles = page.locator(
      'input[type="checkbox"], [role="checkbox"], [role="switch"]',
    );
    const toggleCount = Math.min(await toggles.count(), 10);
    for (let index = 0; index < toggleCount; index += 1) {
      if (page.isClosed()) return changed;
      const toggle = toggles.nth(index);
      const checked = await toggle.isChecked().catch(async () => {
        const value = await toggle.getAttribute("aria-checked").catch(() => null);
        return value === "true";
      });
      if (!checked) {
        await toggle.click({ force: true }).catch(() => {});
        changed = true;
      }
    }

    if (page.isClosed()) return changed;

    const acceptNames = /accept|agree|continue|confirm/i;
    const button = page.getByRole("button", { name: acceptNames }).first();
    if (await button.count().catch(() => 0)) {
      await button.click({ force: true }).catch(() => {});
      return true;
    }

    const fallback = page.locator(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    ).filter({ hasText: acceptNames }).first();
    if (await fallback.count().catch(() => 0)) {
      await fallback.click({ force: true }).catch(() => {});
      return true;
    }

    return changed;
  } catch {
    return false;
  }
}

async function acceptTermsEverywhere(context) {
  let changed = false;
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    changed = (await acceptTerms(page).catch(() => false)) || changed;
  }
  return changed;
}

async function openPopup(context) {
  const popupUrl = browserName === "firefox"
    ? `moz-extension://${FIREFOX_EXTENSION_UUID}/popup/popup.html`
    : `chrome-extension://${CHROME_EXTENSION_ID}/popup/popup.html`;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await acceptTermsEverywhere(context);
    const page = await context.newPage();
    try {
      await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 5_000 });
      if (!page.isClosed() && page.url().startsWith(popupUrl)) return page;
    } catch {
      // Force-installed extensions may need a few seconds to arrive from the store.
    }
    await page.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`${PROVIDER} did not become available in ${browserName}.`);
}

async function startVpn(context) {
  const connectedPattern = /connected|protected|vpn is on|turn off|disconnect/i;
  const startNames = /start vpn|protect me|turn on|connect/i;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await acceptTermsEverywhere(context);
    let page;

    try {
      page = await openPopup(context);
      let text = await bodyText(page);
      if (connectedPattern.test(text)) return;

      await acceptTerms(page);
      if (page.isClosed()) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }

      text = await bodyText(page);
      if (connectedPattern.test(text)) return;

      const button = page.getByRole("button", { name: startNames }).first();
      if (await button.count().catch(() => 0)) {
        await button.click({ force: true });
        return;
      }

      const fallback = page.locator(
        'button, [role="button"], a, input[type="button"], input[type="submit"]',
      ).filter({ hasText: startNames }).first();
      if (await fallback.count().catch(() => 0)) {
        await fallback.click({ force: true });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/closed|destroyed|target/i.test(message)) throw error;
    } finally {
      if (page && !page.isClosed()) await page.close().catch(() => {});
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Could not find the ${PROVIDER} VPN activation control.`);
}

async function fetchIpThroughBrowser(context) {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.co/ip",
    "https://icanhazip.com/",
  ];

  for (const endpoint of endpoints) {
    const page = await context.newPage();
    try {
      await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const ip = extractIp(await bodyText(page));
      if (ip) return ip;
    } catch {
      // Try another endpoint through the browser/VPN route.
    } finally {
      await page.close().catch(() => {});
    }
  }

  throw new Error("Unable to determine the browser public IP after enabling the VPN.");
}

const baselineIp = await fetchIpOutsideBrowser();
console.log(`Runner public IP before ${PROVIDER}: ${baselineIp}`);

const browserType = browserName === "firefox" ? firefox : chromium;
const launchOptions = {
  executablePath: executable,
  headless: false,
  viewport: null,
};

if (browserName === "firefox") {
  launchOptions.firefoxUserPrefs = {
    "browser.shell.checkDefaultBrowser": false,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "extensions.webextensions.uuids": JSON.stringify({
      [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID,
    }),
  };
} else {
  launchOptions.ignoreDefaultArgs = [
    "--disable-extensions",
    "--disable-background-networking",
  ];
  launchOptions.args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1600,1000",
  ];
}

async function launchContext() {
  return browserType.launchPersistentContext(profileDirectory, launchOptions);
}

async function waitForChangedBrowserIp(context, baseline, attempts = 20) {
  let latestIp;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latestIp = await fetchIpThroughBrowser(context).catch(() => undefined);
    if (latestIp && latestIp !== baseline) return latestIp;
  }
  return latestIp;
}

let context = await launchContext();
let vpnIp;
try {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await acceptTermsEverywhere(context);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await startVpn(context);
  vpnIp = await waitForChangedBrowserIp(context, baselineIp);

  if (!vpnIp) {
    throw new Error(`Unable to verify ${PROVIDER} through an external IP check.`);
  }
  if (vpnIp === baselineIp) {
    throw new Error(`${PROVIDER} did not change the browser public IP.`);
  }
  console.log(`${PROVIDER} changed the browser public IP to ${vpnIp}.`);
} finally {
  await context.close();
}

context = await launchContext();
let restartIp;
try {
  restartIp = await waitForChangedBrowserIp(context, baselineIp);
  if (!restartIp || restartIp === baselineIp) {
    throw new Error(`${PROVIDER} did not remain active after a browser restart.`);
  }
} finally {
  await context.close();
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
