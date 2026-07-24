import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extractCanonicalFromHtml, parseJsonLdTexts } from "../src/extract.mjs";
import { evaluateCurrysAttempt, extractCurrysMainPrice } from "../src/currys.mjs";

const fixture = await readFile(new URL("./fixtures/currys-10296598.html", import.meta.url), "utf8");
const jsonLd = fixture.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i)?.[1] ?? "";
const bodyText = fixture.replace(/<[^>]+>/g, "\n").replace(/&quot;/g, '"');

test("extracts the protected Currys identity and £1,799 price", () => {
  const structured = parseJsonLdTexts([jsonLd]);
  assert.equal(structured.structuredPrice, 1799);
  assert.equal(structured.identifiers.mpn, "NX.JU1EK.001");
  assert.equal(structured.identifiers.ean, "4711474906946");
  assert.match(extractCanonicalFromHtml(fixture), /10296598\.html$/);

  const result = evaluateCurrysAttempt({
    requestedUrl: "https://www.currys.co.uk/products/black-10296598.html",
    finalUrl: "https://www.currys.co.uk/products/acer-swift-grey-10296598.html",
    canonicalUrl: "https://www.currys.co.uk/products/acer-swift-grey-10296598.html",
    httpStatus: 200,
    documentTitle: "ACER Swift 16 AI | Currys",
    heading: "ACER Swift 16 AI 16-inch Laptop, Copilot+ PC - Intel Core Ultra X7, 1 TB SSD, Grey",
    bodyText,
    mainText: bodyText,
    jsonLdTexts: [jsonLd],
    priceElementTexts: ["£1,799.00"],
    timestamp: "2026-07-24T00:00:00.000Z",
  }, { itemNumber: "10296598", mpn: "NX.JU1EK.001", ean: "4711474906946", price: 1799 });

  assert.equal(result.status, "success");
  assert.equal(result.mainPurchasePrice, 1799);
  assert.equal(result.structuredOfferPrice, 1799);
  assert.equal(result.retailerItemNumber, "10296598");
  assert.equal(result.manufacturerSku, "NX.JU1EK.001");
  assert.equal(result.ean, "4711474906946");
});

test("does not select finance or previous prices as the purchase price", () => {
  const result = extractCurrysMainPrice("From £72.91 per month\nWas £1,999.00\n£1,799.00\nSave £200.00", []);
  assert.equal(result.value, 1799);
});

test("marks visible and structured price disagreement as a conflict", () => {
  const result = evaluateCurrysAttempt({
    requestedUrl: "https://www.currys.co.uk/products/example-10296598.html",
    finalUrl: "https://www.currys.co.uk/products/example-10296598.html",
    canonicalUrl: "https://www.currys.co.uk/products/example-10296598.html",
    httpStatus: 200,
    documentTitle: "ACER Swift 16 AI",
    heading: "ACER Swift 16 AI",
    bodyText,
    mainText: bodyText.replace("£1,799.00", "£1,599.00"),
    jsonLdTexts: [jsonLd],
    priceElementTexts: ["£1,599.00"],
    timestamp: "2026-07-24T00:00:00.000Z",
  }, { itemNumber: "10296598", mpn: "NX.JU1EK.001" });
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts.join(" "), /disagrees/);
});
