import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedHostname, normalizeIdentifier, validateTargetUrl } from "../src/security.js";

test("allows approved retailer subdomains", () => {
  assert.equal(isAllowedHostname("www.currys.co.uk", ["currys.co.uk"]), true);
  assert.equal(isAllowedHostname("offers.currys.co.uk", ["currys.co.uk"]), true);
});

test("rejects lookalikes and local addresses", () => {
  assert.equal(isAllowedHostname("currys.co.uk.evil.example", ["currys.co.uk"]), false);
  assert.equal(isAllowedHostname("127.0.0.1", ["currys.co.uk"]), false);
  assert.throws(() => validateTargetUrl("file:///etc/passwd"));
});

test("normalizes product identifiers", () => {
  assert.equal(normalizeIdentifier("NX.KA1EK.001"), "NXKA1EK001");
});
