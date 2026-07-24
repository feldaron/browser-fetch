import assert from "node:assert/strict";
import test from "node:test";
import { aggregateAttempts } from "../src/aggregate.mjs";

function attempt(overrides = {}) {
  return {
    status: "success",
    requestedUrl: "https://www.currys.co.uk/products/black-10296598.html",
    finalUrl: "https://www.currys.co.uk/products/grey-10296598.html",
    canonicalUrl: "https://www.currys.co.uk/products/grey-10296598.html",
    httpStatus: 200,
    retailerItemNumber: "10296598",
    productTitle: "ACER Swift 16 AI 16-inch Laptop - Intel Core Ultra X7, 1 TB SSD, Grey",
    manufacturer: "ACER",
    modelFamily: "Swift 16 AI",
    manufacturerSku: "NX.JU1EK.001",
    ean: "4711474906946",
    cpu: "Intel Core Ultra X7 358H",
    gpu: null,
    ram: "32 GB LPDDR5X",
    storage: "1 TB SSD",
    display: "16 / OLED / 2.8K / 120 Hz",
    colour: "Grey",
    mainPurchasePrice: 1799,
    deliveryCharge: 0,
    effectivePrice: 1799,
    currency: "GBP",
    availability: "InStock",
    inStock: true,
    structuredOfferPrice: 1799,
    timestamp: "2026-07-24T00:00:00.000Z",
    verificationMethod: "headed Google Chrome / isolated Playwright context / Currys main purchase block",
    identityChecks: { strongIdentity: true },
    conflicts: [],
    evidenceUrls: ["https://www.currys.co.uk/products/grey-10296598.html"],
    provenance: {},
    ...overrides,
  };
}

test("accepts six agreeing isolated loads", () => {
  const result = aggregateAttempts(Array.from({ length: 6 }, () => attempt()), { itemNumber: "10296598", mpn: "NX.JU1EK.001", price: 1799 });
  assert.equal(result.status, "success");
  assert.equal(result.eligible, true);
  assert.equal(result.attempts.length, 6);
});

test("quarantines a cross-load price change", () => {
  const result = aggregateAttempts([attempt(), attempt({ mainPurchasePrice: 1599, effectivePrice: 1599 })]);
  assert.equal(result.status, "conflict");
  assert.equal(result.eligible, false);
  assert.match(result.conflicts.join(" "), /multiple main prices/);
});

test("does not treat unrelated broad-body CPU drift as a different product", () => {
  const result = aggregateAttempts([
    attempt({ cpu: "AMD Ryzen AI 5 340", ram: "16 GB" }),
    attempt({ cpu: "Intel Core Ultra 5", ram: "32 GB" }),
  ]);
  assert.equal(result.status, "success");
  assert.equal(result.eligible, true);
});
