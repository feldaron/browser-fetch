import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/private-browser.yml", import.meta.url);
const smokeWorkflowPath = new URL("../.github/workflows/private-browser-vpn-smoke.yml", import.meta.url);
const launcherPath = new URL("../scripts/launch-private-browser.mjs", import.meta.url);
const vpnSetupPath = new URL("../scripts/prepare-private-vpn.mjs", import.meta.url);
const vpnChromePath = new URL("../scripts/prepare-private-vpn-chrome.mjs", import.meta.url);
const vpnRuntimePath = new URL("../scripts/prepare-private-vpn-runtime.mjs", import.meta.url);

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

test("Firefox stages the official add-on and resolves its runtime origin without privileged APIs", async () => {
  const [workflow, launcher, vpnSetup, vpnRuntime] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
    readFile(vpnRuntimePath, "utf8"),
  ]);
  assert.match(workflow, /addons\.mozilla\.org\/api\/v5\/addons\/addon\/browsec/);
  assert.match(workflow, /BROWSEC_FIREFOX_EXTENSION_ID/);
  assert.match(launcher, /BROWSEC_FIREFOX_EXTENSION_ID/);
  assert.match(vpnSetup, /browsec@browsec\.com/);
  assert.match(vpnSetup, /about:debugging#\/runtime\/this-firefox/);
  assert.doesNotMatch(vpnSetup, /ChromeUtils\.importESModule/);
  assert.match(vpnRuntime, /selenium-webdriver/);
  assert.match(vpnRuntime, /restart-persistent/);
});

test("Chrome uses a managed Web Store install in the same persistent normal profile used by the session", async () => {
  const [workflow, smokeWorkflow, vpnSetup, vpnChrome] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(smokeWorkflowPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
    readFile(vpnChromePath, "utf8"),
  ]);
  assert.match(vpnSetup, /prepare-private-vpn-chrome\.mjs/);
  assert.match(workflow, /ExtensionSettings/);
  assert.match(smokeWorkflow, /ExtensionSettings/);
  assert.match(workflow, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(smokeWorkflow, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(vpnChrome, /--remote-debugging-port=0/);
  assert.match(vpnChrome, /chrome-extension:\/\/\$\{EXTENSION_ID\}\/popup\/popup\.html/);
  assert.match(vpnChrome, /normal Chrome public IP/);
  assert.match(vpnChrome, /normal Chrome restart/);
  assert.doesNotMatch(vpnChrome, /webExtension\.install/);
  assert.doesNotMatch(vpnChrome, /enableBidi/);
});
