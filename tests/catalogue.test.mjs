import assert from "node:assert/strict";
import test from "node:test";
import { currysCataloguePageUrl } from "../src/catalogue.mjs";

test("maps Currys catalogue page 6 to start=100 for 20 products", () => {
  const url = new URL(currysCataloguePageUrl("https://www.currys.co.uk/computing/laptops/laptops/windows-laptops?searchTerm=laptop", 6, 20));
  assert.equal(url.searchParams.get("start"), "100");
  assert.equal(url.searchParams.get("sz"), "20");
  assert.equal(url.searchParams.get("searchTerm"), "laptop");
});
