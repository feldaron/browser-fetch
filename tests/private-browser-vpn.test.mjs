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

test("Chrome uses WebDriver BiDi rather than managed-policy or legacy packed-extension injection", async () => {
  const [workflow, smokeWorkflow, vpnSetup, vpnChrome] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(smokeWorkflowPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
    readFile(vpnChromePath, "utf8"),
  ]);

  assert.match(vpnSetup, /prepare-private-vpn-chrome\.mjs/);
  assert.match(vpnChrome, /clients2\.google\.com\/service\/update2\/crx/);
  assert.match(vpnChrome, /webExtension\.install/);
  assert.match(vpnChrome, /enableBidi/);
  assert.match(vpnChrome, /--enable-unsafe-extension-debugging/);
  assert.match(vpnChrome, /restart-persistent/);
  assert.doesNotMatch(workflow, /ExtensionSettings/);
  assert.doesNotMatch(smokeWorkflow, /ExtensionSettings/);
  assert.match(smokeWorkflow, /prepare-private-vpn-chrome\.mjs/);
});
