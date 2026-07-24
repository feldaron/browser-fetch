import assert from "node:assert/strict";
import test from "node:test";
import { currysCataloguePageUrl, selectCurrysProductUrls } from "../src/catalogue.mjs";

test("maps Currys catalogue page 6 to start=100 for 20 products", () => {
  const url = new URL(currysCataloguePageUrl("https://www.currys.co.uk/computing/laptops/laptops/windows-laptops?searchTerm=laptop", 6, 20));
  assert.equal(url.searchParams.get("start"), "100");
  assert.equal(url.searchParams.get("sz"), "20");
  assert.equal(url.searchParams.get("searchTerm"), "laptop");
});

test("caps unique Currys product links to the requested page size", () => {
  const hrefs = Array.from({ length: 27 }, (_, index) => `/products/example-${String(10290000 + index)}.html`);
  hrefs.splice(3, 0, hrefs[0]);
  hrefs.push("https://example.com/products/not-allowed-10299999.html");
  const selection = selectCurrysProductUrls(hrefs, "https://www.currys.co.uk/computing/laptops", 20);
  assert.equal(selection.productUrls.length, 20);
  assert.equal(selection.candidateCount, 27);
  assert.equal(selection.capped, true);
  assert.match(selection.productUrls[0], /10290000\.html$/);
  assert.match(selection.productUrls.at(-1), /10290019\.html$/);
});
