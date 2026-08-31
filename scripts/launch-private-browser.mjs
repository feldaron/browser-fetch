import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIREFOX_EXTENSION_ID = "browsec@browsec.com";
const FIREFOX_EXTENSION_UUID = "8f9b7b1a-6d40-4f5c-a7db-5e8f86f24691";

const rawUrl = process.argv[2] ?? "https://www.currys.co.uk/";
const startUrl = new URL(rawUrl);

if (!["http:", "https:"].includes(startUrl.protocol)) {
  throw new Error("The private browser start URL must use http or https.");
}

const browserName = (process.env.PRIVATE_BROWSER ?? "firefox").toLowerCase();
if (!["chrome", "firefox"].includes(browserName)) {
  throw new Error(`Unsupported private browser: ${browserName}`);
}

const executable = process.env.PRIVATE_BROWSER_EXECUTABLE ??
  (browserName === "firefox" ? "firefox" : "google-chrome");
const profileRoot = process.env.PRIVATE_BROWSER_PROFILE_ROOT ??
  "/tmp/private-browser-profile";
const profileDirectory = path.join(profileRoot, browserName);
const downloadDirectory = process.env.PRIVATE_BROWSER_DOWNLOAD_DIRECTORY ??
  "/tmp/private-browser/downloads";

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(downloadDirectory, { recursive: true }),
]);

if (browserName === "firefox") {
  const downloadPreference = JSON.stringify(downloadDirectory);
  await writeFile(
    path.join(profileDirectory, "user.js"),
    [
      `user_pref("browser.download.dir", ${downloadPreference});`,
      'user_pref("browser.download.folderList", 2);',
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.download.alwaysOpenPanel", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({
        [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID,
      }))});`,
      "",
    ].join("\n"),
    "utf8",
  );
} else {
  const defaultProfileDirectory = path.join(profileDirectory, "Default");
  const preferencesPath = path.join(defaultProfileDirectory, "Preferences");
  await mkdir(defaultProfileDirectory, { recursive: true });

  let preferences = {};
  try {
    preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  } catch {
    // A fresh Chrome profile has no Preferences file yet.
  }

  preferences.download = {
    ...(preferences.download ?? {}),
    default_directory: downloadDirectory,
    directory_upgrade: true,
    prompt_for_download: false,
  };
  preferences.safebrowsing = {
    ...(preferences.safebrowsing ?? {}),
    enabled: true,
  };

  await writeFile(
    preferencesPath,
    `${JSON.stringify(preferences)}\n`,
    "utf8",
  );
}

const args = browserName === "firefox"
  ? [
      "--no-remote",
      "--new-instance",
      "--profile",
      profileDirectory,
      "--width",
      "1600",
      "--height",
      "1000",
      startUrl.toString(),
    ]
  : [
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      "--window-size=1600,1000",
      startUrl.toString(),
    ];

const browser = spawn(executable, args, {
  env: process.env,
  stdio: "inherit",
});

browser.on("error", (error) => {
  console.error(`Unable to start ${browserName}: ${error.message}`);
  process.exitCode = 1;
});

console.log(`Private ${browserName} opened at ${startUrl.toString()}`);

let closing = false;
function close(signal) {
  if (closing) return;
  closing = true;
  browser.kill(signal);
}

process.on("SIGINT", () => close("SIGINT"));
process.on("SIGTERM", () => close("SIGTERM"));

const exitCode = await new Promise((resolve) => {
  browser.once("exit", (code, signal) => {
    resolve(code ?? (signal ? 1 : 0));
  });
});

process.exitCode = exitCode;
