import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/private-browser.yml", import.meta.url);
const launcherPath = new URL("../scripts/launch-private-browser.mjs", import.meta.url);
const vpnSetupPath = new URL("../scripts/prepare-private-vpn.mjs", import.meta.url);

test("private browser defaults to Firefox and gates exposure on a verified VPN", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /default: firefox/);
  assert.match(workflow, /Configure Browsec VPN policy/);
  assert.match(workflow, /Install, activate and verify Browsec VPN/);
  assert.match(workflow, /restartVerified == true/);

  const verifyPosition = workflow.indexOf("Install, activate and verify Browsec VPN");
  const tunnelPosition = workflow.indexOf("Connect privatebrowser.laptopvalue.co.uk");
  assert.ok(verifyPosition >= 0 && tunnelPosition > verifyPosition);
});

test("Browsec is configured for both Firefox and Chrome", async () => {
  const [workflow, launcher, vpnSetup] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(vpnSetupPath, "utf8"),
  ]);

  for (const content of [workflow, launcher, vpnSetup]) {
    assert.match(content, /browsec@browsec\.com/);
  }
  assert.match(workflow, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(vpnSetup, /omghfjlpggmjjaagoclmmobgdodcjboh/);
  assert.match(vpnSetup, /restart-persistent/);
});
