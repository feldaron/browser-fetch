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


test("maps Currys Business page 2 to one-based start=49 for 48 products", () => {
  const url = new URL(currysCataloguePageUrl("https://business.currys.co.uk/catalogue/computing/laptops/windows-laptop?from=main-menu", 2, 48));
  assert.equal(url.searchParams.get("start"), "49");
  assert.equal(url.searchParams.get("sz"), null);
  assert.equal(url.searchParams.get("from"), "main-menu");
});

test("accepts only literal Currys Business Windows-laptop card links", () => {
  const hrefs = [
    "/catalogue/computing/laptops/windows-laptop/asus-vivobook-14/N596932W?from=category&heat=img",
    "/catalogue/computing/laptops/windows-laptop/asus-vivobook-14/N596932W?from=category&heat=title",
    "/catalogue/computing/laptops/chromebook/example/N111111W",
    "https://example.com/catalogue/computing/laptops/windows-laptop/example/N222222W",
  ];
  const selection = selectCurrysProductUrls(hrefs, "https://business.currys.co.uk/catalogue/computing/laptops/windows-laptop", 48);
  assert.deepEqual(selection.productUrls, [
    "https://business.currys.co.uk/catalogue/computing/laptops/windows-laptop/asus-vivobook-14/N596932W?from=category&heat=img",
  ]);
  assert.equal(selection.candidateCount, 1);
});
