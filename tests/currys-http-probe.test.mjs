import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCurrysHttpEvidence,
  probeCurrysProduct,
  runRepeatedProbe,
} from "../src/currys-http-probe.mjs";

const URL = "https://www.currys.co.uk/products/example-laptop-10296598.html";

function fixture({ price = 1599, availability = "https://schema.org/InStock", sku = "10296598" } = {}) {
  return `<!doctype html>
<html>
<head>
  <title>ACER Swift 16 AI | Currys</title>
  <link rel="canonical" href="${URL}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "ACER Swift 16 AI 16-inch Laptop",
    "sku": "${sku}",
    "mpn": "NX.JU1EK.001",
    "gtin13": "4711474906946",
    "offers": {
      "@type": "Offer",
      "price": "${price}",
      "priceCurrency": "GBP",
      "availability": "${availability}"
    }
  }
  </script>
</head>
<body><h1>ACER Swift 16 AI 16-inch Laptop</h1></body>
</html>`;
}

test("extracts exact identity, price and decisive availability without a browser", () => {
  const result = extractCurrysHttpEvidence(fixture(), URL, URL, 200);
  assert.equal(result.status, "success");
  assert.equal(result.eligible, true);
  assert.equal(result.retailerItemNumber, "10296598");
  assert.equal(result.mainPurchasePrice, 1599);
  assert.equal(result.currency, "GBP");
  assert.equal(result.inStock, true);
  assert.equal(result.manufacturerSku, "NX.JU1EK.001");
  assert.equal(result.ean, "4711474906946");
  assert.equal(result.provenance.browserUsed, false);
});

test("fails closed when availability is not published", () => {
  const result = extractCurrysHttpEvidence(fixture({ availability: "" }), URL, URL, 200);
  assert.equal(result.status, "conflict");
  assert.equal(result.eligible, false);
  assert.match(result.conflicts.join("\n"), /availability is missing/);
});

test("quarantines identity disagreement", () => {
  const result = extractCurrysHttpEvidence(fixture({ sku: "10200000" }), URL, URL, 200);
  assert.equal(result.status, "conflict");
  assert.equal(result.eligible, false);
  assert.match(result.conflicts.join("\n"), /structured SKU/);
});

test("detects a retailer block page", () => {
  const html = "<html><title>Attention Required! | Cloudflare</title><body>Sorry, you have been blocked</body></html>";
  const result = extractCurrysHttpEvidence(html, URL, URL, 403);
  assert.equal(result.status, "blocked");
  assert.equal(result.eligible, false);
});

test("uses an honest, cookie-free request", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return { url: String(url), status: 200, text: async () => fixture() };
  };
  const result = await probeCurrysProduct(URL, { fetchImpl });
  assert.equal(result.status, "success");
  assert.equal(request.options.redirect, "follow");
  assert.equal(request.options.headers.Cookie, undefined);
  assert.match(request.options.headers["User-Agent"], /LaptopValuePriceMonitor/);
});

test("repeated probe rejects changing price evidence", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return {
      url: String(url),
      status: 200,
      text: async () => fixture({ price: calls === 1 ? 1599 : 1499 }),
    };
  };
  const result = await runRepeatedProbe(URL, { fetchImpl, repeatCount: 3, delayMs: 0 });
  assert.equal(result.status, "conflict");
  assert.equal(result.eligible, false);
  assert.match(result.conflicts.join("\n"), /readings disagree/);
});
