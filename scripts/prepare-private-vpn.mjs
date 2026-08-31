import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

if (browserName === "chrome") {
  await import("./prepare-private-vpn-chrome.mjs");
} else {
  const firefoxExtensionId = process.env.BROWSEC_FIREFOX_EXTENSION_ID ?? "browsec@browsec.com";
  const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ?? "/tmp/private-browser-profile";

  process.env.PRIVATE_BROWSER_FIREFOX_VPN_XPI ??= path.join(
    profileRoot,
    "firefox",
    "extensions",
    `${firefoxExtensionId}.xpi`,
  );

  // Firefox assigns a runtime moz-extension:// UUID when Browsec is installed.
  // Firefox 154 no longer exposes the old privileged WebExtensionPolicy lookup to
  // WebDriver scripts, so resolve the UUID from Firefox's own about:debugging UI.
  const runtimeSourceUrl = new URL("./prepare-private-vpn-runtime.mjs", import.meta.url);
  const original = await readFile(runtimeSourceUrl, "utf8");
  const replacement = `async function resolveFirefoxExtensionUuid(driver) {
  const originalHandle = await driver.getWindowHandle().catch(() => undefined);
  const originalUrl = await driver.getCurrentUrl().catch(() => "about:blank");

  try {
    await driver.get("about:debugging#/runtime/this-firefox");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(500);
      const text = await bodyText(driver);
      const source = await driver.getPageSource().catch(() => "");
      const markerIndex = text.indexOf(FIREFOX_EXTENSION_ID);
      const nearby = markerIndex >= 0
        ? text.slice(Math.max(0, markerIndex - 2_000), markerIndex + 4_000)
        : text;

      const fromText = nearby.match(/Internal UUID\\s+([0-9a-f-]{36})/i)?.[1];
      const fromManifest = source.match(/moz-extension:\\/\\/([0-9a-f-]{36})\\/manifest\\.json/i)?.[1];
      const uuid = fromText ?? fromManifest;
      if (uuid) {
        firefoxExtensionUuid = uuid;
        console.log(\`Resolved Firefox Browsec runtime UUID from about:debugging: \${uuid}\`);
        return;
      }
    }
  } finally {
    if (originalHandle) await driver.switchTo().window(originalHandle).catch(() => {});
    await driver.get(originalUrl || "about:blank").catch(() => {});
  }

  throw new Error("Firefox did not expose Browsec's runtime extension UUID in about:debugging.");
}

function popupUrl()`;

  const patched = original.replace(
    /async function resolveFirefoxExtensionUuid\(driver\) \{[\s\S]*?\n\}\n\nfunction popupUrl\(\)/,
    replacement,
  );
  if (patched === original) {
    throw new Error("Unable to patch the Firefox Browsec UUID resolver.");
  }

  const patchedRuntimeUrl = new URL("./.prepare-private-vpn-firefox-runtime.mjs", import.meta.url);
  await writeFile(patchedRuntimeUrl, patched, "utf8");
  await import(`${patchedRuntimeUrl.href}?run=${Date.now()}`);
}
