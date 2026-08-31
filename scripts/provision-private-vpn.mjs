import { chromium, firefox } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ??
  (browserName === "firefox" ? "firefox" : "google-chrome");
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ??
  "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, browserName);
const reportPath = process.env.PRIVATE_BROWSER_VPN_REPORT ??
  "/tmp/private-browser/vpn.json";
const chromeExtensionId = process.env.BROWSEC_CHROME_EXTENSION_ID ??
  "omghfjlpggmjjaagoclmmobgdodcjboh";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(path.dirname(reportPath), { recursive: true }),
]);

function parseIp(value) {
  if (!value) return null;
  const text = String(value).trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.ip === "string") return parsed.ip.trim();
  } catch {
    // Plain-text IP responses are also supported.
  }
  const candidate = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]{2,}\b/i)?.[0];
  return candidate ?? null;
}

async function directPublicIp() {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(12_000),
        headers: { "user-agent": "LaptopValue-private-browser-vpn-check/1.0" },
      });
      if (!response.ok) continue;
      const ip = parseIp(await response.text());
      if (ip) return ip;
    } catch {
      // Try the next endpoint.
    }
  }
  throw new Error("Unable to determine the GitHub runner public IP before VPN activation.");
}

function launchOptions() {
  if (browserName === "chrome") {
    return {
      executablePath: executable,
      headless: false,
      viewport: null,
      ignoreDefaultArgs: [
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
      ],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1600,1000",
      ],
    };
  }

  return {
    executablePath: executable,
    headless: false,
    viewport: null,
    args: ["--width", "1600", "--height", "1000"],
  };
}

async function launchContext() {
  const type = browserName === "chrome" ? chromium : firefox;
  return type.launchPersistentContext(profileDirectory, launchOptions());
}

async function browserPublicIp(context) {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
  ];

  for (const endpoint of endpoints) {
    const page = await context.newPage();
    try {
      const response = await page.goto(endpoint, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      if (!response?.ok()) continue;
      const ip = parseIp(await page.locator("body").innerText({ timeout: 5_000 }));
      if (ip) return ip;
    } catch {
      // Try the next endpoint.
    } finally {
      await page.close().catch(() => {});
    }
  }
  return null;
}

async function firefoxExtensionOrigin(context) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.url().startsWith("moz-extension://")) {
        return new URL(page.url()).origin;
      }
    }

    try {
      const extensions = JSON.parse(
        await readFile(path.join(profileDirectory, "extensions.json"), "utf8"),
      );
      const browsec = extensions.addons?.find((addon) => {
        const haystack = [
          addon.id,
          addon.defaultLocale?.name,
          addon.sourceURI,
          addon.updateURL,
        ].filter(Boolean).join(" ");
        return /browsec/i.test(haystack);
      });

      if (browsec?.id) {
        const prefs = await readFile(path.join(profileDirectory, "prefs.js"), "utf8");
        const match = prefs.match(
          /^user_pref\("extensions\.webextensions\.uuids", (.+)\);$/m,
        );
        if (match) {
          const mappingText = JSON.parse(match[1]);
          const mapping = JSON.parse(mappingText);
          const uuid = mapping[browsec.id];
          if (uuid) return `moz-extension://${uuid}`;
        }
      }
    } catch {
      // Firefox can still be finishing the policy-driven extension install.
    }

    await sleep(2_000);
  }

  throw new Error("Browsec did not appear in the Firefox profile within 90 seconds.");
}

async function extensionPopupUrl(context) {
  if (browserName === "chrome") {
    return `chrome-extension://${chromeExtensionId}/popup/popup.html`;
  }
  const origin = await firefoxExtensionOrigin(context);
  return `${origin}/popup/popup.html`;
}

function isBrowsecPage(page, extensionOrigin) {
  const url = page.url();
  return url.startsWith(extensionOrigin) || /(^|\.)browsec\.com\//i.test(url);
}

async function acceptBrowsecConsent(page, extensionOrigin) {
  if (!isBrowsecPage(page, extensionOrigin)) return false;

  let text = "";
  try {
    text = await page.locator("body").innerText({ timeout: 2_000 });
  } catch {
    return false;
  }

  if (!/(terms|conditions|privacy|consent|agreement)/i.test(text)) return false;

  let changed = false;
  const nativeChecks = page.locator('input[type="checkbox"]');
  for (let index = 0; index < await nativeChecks.count(); index += 1) {
    const checkbox = nativeChecks.nth(index);
    if (await checkbox.isVisible().catch(() => false) &&
        !(await checkbox.isChecked().catch(() => false))) {
      await checkbox.check({ force: true }).catch(() => {});
      changed = true;
    }
  }

  for (const role of ["checkbox", "switch"]) {
    const controls = page.getByRole(role);
    for (let index = 0; index < await controls.count(); index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const checked = await control.getAttribute("aria-checked").catch(() => null);
      if (checked === "true") continue;
      await control.click({ force: true }).catch(() => {});
      changed = true;
    }
  }

  const consentButton = page.getByRole("button", {
    name: /^(accept|agree|i agree|continue)$/i,
  }).first();
  if (await consentButton.isVisible().catch(() => false)) {
    await consentButton.click({ force: true }).catch(() => {});
    changed = true;
  }

  return changed;
}

async function clickStartVpn(page) {
  const candidates = [
    page.getByRole("button", { name: /start vpn/i }).first(),
    page.getByRole("button", { name: /protect me/i }).first(),
    page.getByRole("button", { name: /turn on/i }).first(),
    page.getByRole("button", { name: /^connect$/i }).first(),
    page.getByText(/^start vpn$/i).first(),
    page.getByText(/^protect me$/i).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function activateAndVerify(context, directIp) {
  const popupUrl = await extensionPopupUrl(context);
  const extensionOrigin = new URL(popupUrl).origin;
  const popup = await context.newPage();
  const deadline = Date.now() + 120_000;
  let lastIp = null;

  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      await acceptBrowsecConsent(page, extensionOrigin).catch(() => {});
    }

    try {
      await popup.goto(popupUrl, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      await acceptBrowsecConsent(popup, extensionOrigin).catch(() => {});
      await clickStartVpn(popup);
    } catch {
      // Force-install can take a few seconds before the popup URL becomes available.
    }

    await sleep(2_500);
    lastIp = await browserPublicIp(context);
    if (lastIp && lastIp !== directIp) {
      await popup.close().catch(() => {});
      return { popupUrl, vpnIp: lastIp };
    }
  }

  throw new Error(
    `Browsec did not produce a different browser IP. Runner=${directIp}, browser=${lastIp ?? "unknown"}.`,
  );
}

async function verifyPersistence(directIp) {
  const context = await launchContext();
  try {
    const deadline = Date.now() + 60_000;
    let lastIp = null;
    while (Date.now() < deadline) {
      lastIp = await browserPublicIp(context);
      if (lastIp && lastIp !== directIp) return lastIp;
      await sleep(3_000);
    }
    throw new Error(
      `Browsec did not remain active after a browser restart. Runner=${directIp}, browser=${lastIp ?? "unknown"}.`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

const directIp = await directPublicIp();
console.log(`Direct runner IP captured for VPN verification: ${directIp}`);

let context = await launchContext();
let activation;
try {
  activation = await activateAndVerify(context, directIp);
  console.log(`Browsec changed browser egress to ${activation.vpnIp}.`);
} finally {
  await context.close().catch(() => {});
}

await sleep(1_500);
const persistedIp = await verifyPersistence(directIp);
console.log(`Browsec remained active after restart with browser egress ${persistedIp}.`);

const report = {
  provider: "Browsec",
  browser: browserName,
  installed: true,
  active: true,
  restart_persistence_verified: true,
  direct_ip: directIp,
  vpn_ip: persistedIp,
  verified_at: new Date().toISOString(),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`VPN verification report written to ${reportPath}.`);
