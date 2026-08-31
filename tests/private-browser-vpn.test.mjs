import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/private-browser.yml", import.meta.url);
const smokeWorkflowPath = new URL("../.github/workflows/private-browser-vpn-smoke.yml", import.meta.url);
const launcherPath = new URL("../scripts/launch-private-browser.mjs", import.meta.url);
const vpnSetupPath = new URL("../scripts/prepare-private-vpn.mjs", import.meta.url);
const vpnChromePath = new URL("../scripts/prepare-private-vpn-chrome.mjs", import.meta.url);

test("private browser defaults to Firefox and gates exposure on a verified VPN", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /default: firefox/);
  assert.match(workflow, /Stage Browsec VPN extension/);
  assert.match(workflow, /Install, activate and verify Browsec VPN/);
  assert.match(workflow, /restartVerified == true/);
  const verifyPosition = workflow.indexOf("Install, activate and verify Browsec VPN");
  const tunnelPosition = workflow.indexOf("Connect privatebrowser.laptopvalue.co.uk");
  assert.ok(verifyPosition >= 0 && tunnelPosition > verifyPosition);
});

test("Firefox stages the official add-on and persists its WebDriver profile", async () => {
  const [workflow, launcher, vpnSetup] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
  ]);
  assert.match(workflow, /addons\.mozilla\.org\/api\/v5\/addons\/addon\/browsec/);
  assert.match(workflow, /BROWSEC_FIREFOX_EXTENSION_ID/);
  assert.match(launcher, /BROWSEC_FIREFOX_EXTENSION_ID/);
  assert.match(vpnSetup, /browsec@browsec\.com/);
  assert.match(vpnSetup, /prefs\.js/);
  assert.match(vpnSetup, /extensions\.json/);
  assert.match(vpnSetup, /moz:profile/);
  assert.match(vpnSetup, /persistRuntimeProfile/);
  assert.match(vpnSetup, /restartVerified/);
  assert.doesNotMatch(vpnSetup, /about:debugging#\/runtime\/this-firefox/);
  assert.match(vpnSetup, /setContext\("chrome"\)/);
  assert.match(vpnSetup, /ExtensionParent\.GlobalManager\.getExtension/);
  assert.match(vpnSetup, /ExtensionStorageIDB\.selectBackend/);
  assert.match(vpnSetup, /ExtensionStorageIDB\.notifyListeners/);
});

test("Chrome force-installs the Store extension and launches only its verified persistent profile", async () => {
  const [workflow, smokeWorkflow, launcher, vpnSetup, vpnChrome] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(smokeWorkflowPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
    readFile(vpnChromePath, "utf8"),
  ]);

  assert.match(vpnSetup, /prepare-private-vpn-chrome\.mjs/);
  for (const content of [workflow, smokeWorkflow]) {
    assert.match(content, /ExtensionSettings/);
    assert.match(content, /omghfjlpggmjjaagoclmmobgdodcjboh/);
    assert.match(content, /force_installed/);
    assert.match(content, /clients2\.google\.com\/service\/update2\/crx/);
  }

  assert.match(vpnChrome, /const EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh"/);
  assert.match(vpnChrome, /popupUrl/);
  assert.match(vpnChrome, /managed normal Chrome public IP/);
  assert.match(vpnChrome, /normal Chrome restart/);
  assert.doesNotMatch(vpnChrome, /webExtension\.install/);
  assert.doesNotMatch(vpnChrome, /enableBidi/);

  assert.match(launcher, /const CHROME_EXTENSION_ID = "omghfjlpggmjjaagoclmmobgdodcjboh"/);
  assert.match(launcher, /vpnStatus\?\.extensionId !== CHROME_EXTENSION_ID/);
  assert.match(launcher, /restartVerified !== true/);
  assert.doesNotMatch(launcher, /--load-extension=/);
});
