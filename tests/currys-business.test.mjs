import assert from "node:assert/strict";
import test from "node:test";
import { currysItemNumber, evaluateCurrysAttempt, extractCurrysMainPrice } from "../src/currys.mjs";

const productUrl = "https://business.currys.co.uk/catalogue/computing/laptops/windows-laptop/asus-vivobook-14-x1404va-14-laptop-intel-core-5-512-gb-ssd-silver/N596932W";
const title = 'ASUS Vivobook 14 X1404VA 14" Laptop - Intel Core 5, 512 GB SSD, Silver';
const mainText = `${title}
Product code: N596932W | X1404VA-EB1154W
Windows 11
Intel Core 5 120U Processor
RAM: 16 GB / Storage: 512 GB SSD
Full HD screen / 60 Hz
£332.50 ex VAT
£399.00 inc VAT
10+ in stock
Add to basket`;
const jsonLdTexts = [JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: title,
  brand: { "@type": "Brand", name: "ASUS" },
  mpn: "X1404VA-EB1154W",
  offers: {
    "@type": "Offer",
    price: "332.50",
    priceCurrency: "GBP",
    availability: "https://schema.org/InStock",
  },
})];

test("extracts the published Currys Business inc-VAT price", () => {
  const price = extractCurrysMainPrice(mainText, []);
  assert.equal(price.value, 399);
  assert.equal(price.exVatValue, 332.5);
  assert.equal(price.method, "business-inc-vat");
});

test("verifies Currys Business identity and retains the inc-VAT price", () => {
  const result = evaluateCurrysAttempt({
    requestedUrl: productUrl,
    finalUrl: productUrl,
    canonicalUrl: productUrl,
    httpStatus: 200,
    documentTitle: title,
    heading: title,
    bodyText: mainText,
    mainText,
    jsonLdTexts,
    priceElementTexts: [],
    timestamp: "2026-07-27T00:00:00.000Z",
  }, { itemNumber: "N596932W", mpn: "X1404VA-EB1154W", ean: null, price: null });

  assert.equal(currysItemNumber(productUrl), "N596932W");
  assert.equal(result.status, "success");
  assert.equal(result.eligible, undefined);
  assert.equal(result.mainPurchasePrice, 399);
  assert.equal(result.exVatPrice, 332.5);
  assert.equal(result.vatIncluded, true);
  assert.equal(result.manufacturerSku, "X1404VA-EB1154W");
  assert.equal(result.identityChecks.strongIdentity, true);
  assert.equal(result.provenance.priceBasis, "published-inc-vat");
});

test("quarantines an inconsistent published VAT pair", () => {
  const inconsistent = mainText.replace("£399.00 inc VAT", "£400.00 inc VAT");
  const result = evaluateCurrysAttempt({
    requestedUrl: productUrl,
    finalUrl: productUrl,
    canonicalUrl: productUrl,
    httpStatus: 200,
    documentTitle: title,
    heading: title,
    bodyText: inconsistent,
    mainText: inconsistent,
    jsonLdTexts,
    priceElementTexts: [],
    timestamp: "2026-07-27T00:00:00.000Z",
  }, { itemNumber: "N596932W", mpn: "X1404VA-EB1154W", ean: null, price: null });

  assert.equal(result.status, "conflict");
  assert.match(result.conflicts.join(" "), /not 20% above/);
});
