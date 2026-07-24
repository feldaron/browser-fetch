import assert from "node:assert/strict";
import test from "node:test";
import { choosePrice, extractStructuredData, identifierMatches } from "../src/extract.js";

test("extracts Product JSON-LD price and identifiers", () => {
  const result = extractStructuredData([
    JSON.stringify({
      "@type": "Product",
      sku: "ABC-123",
      gtin13: "1234567890123",
      offers: { "@type": "Offer", price: "599.99", availability: "https://schema.org/InStock" },
    }),
  ]);
  assert.equal(choosePrice(result.priceCandidates)?.value, 599.99);
  assert.deepEqual(result.identifiers.sku, ["ABC-123"]);
  assert.equal(result.availability, "InStock");
});

test("requires every supplied identifier", () => {
  const identifiers = { sku: ["ABC-123"], ean: ["1234567890123"], mpn: [] };
  assert.equal(identifierMatches("ABC123", "1234567890123", identifiers, ""), true);
  assert.equal(identifierMatches("WRONG", "1234567890123", identifiers, ""), false);
});
