import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/private-browser.yml", import.meta.url);
const launcherPath = new URL("../scripts/launch-private-browser.mjs", import.meta.url);
const vpnSetupPath = new URL("../scripts/prepare-private-vpn.mjs", import.meta.url);
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

test("Browsec is installed and verified for both Firefox and Chrome", async () => {
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
  assert.match(vpnRuntime, /selenium-webdriver/);
  assert.match(vpnRuntime, /WebExtensionPolicy/);

  assert.match(vpnSetup, /clients2\.google\.com\/service\/update2\/crx/);
  assert.match(vpnSetup, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(vpnRuntime, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(vpnRuntime, /restart-persistent/);
});
