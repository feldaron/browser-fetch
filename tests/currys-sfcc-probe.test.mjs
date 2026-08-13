import test from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint } from "../src/currys-sfcc-probe.mjs";

const endpoint = {
  name: "Product-Variation",
  url: (pid) => `https://www.currys.co.uk/on/demandware.store/Sites-curryspcworlduk-Site/en_GB/Product-Variation?pid=${pid}&quantity=1`,
};

function response(body, { status = 200, contentType = "application/json" } = {}) {
  return {
    url: endpoint.url("10296598"),
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    text: async () => body,
  };
}

test("recognises a useful JSON endpoint carrying identity, price and stock", async () => {
  const body = JSON.stringify({
    product: {
      id: "10296598",
      price: { sales: { value: 1599, currency: "GBP" } },
      availability: { messages: ["In stock"], inStock: true },
    },
  });
  const result = await probeEndpoint(endpoint, "10296598", {
    fetchImpl: async () => response(body),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.blocked, false);
  assert.equal(result.containsRequestedItem, true);
  assert.deepEqual(result.priceCandidates, [1599]);
  assert.match(result.availabilitySignals.join("\n"), /In stock/i);
  assert.equal(result.useful, true);
});

test("fails closed when the requested item is absent", async () => {
  const body = JSON.stringify({
    product: {
      id: "10200000",
      price: { sales: { value: 1599, currency: "GBP" } },
      availability: "https://schema.org/InStock",
    },
  });
  const result = await probeEndpoint(endpoint, "10296598", {
    fetchImpl: async () => response(body),
  });
  assert.equal(result.containsRequestedItem, false);
  assert.equal(result.useful, false);
});

test("detects a hard access block", async () => {
  const html = "<html><title>Attention Required!</title><body>Sorry, you have been blocked</body></html>";
  const result = await probeEndpoint(endpoint, "10296598", {
    fetchImpl: async () => response(html, { status: 403, contentType: "text/html" }),
  });
  assert.equal(result.blocked, true);
  assert.equal(result.useful, false);
});

test("rejects invalid item numbers before making a request", async () => {
  await assert.rejects(
    () => probeEndpoint(endpoint, "123", { fetchImpl: async () => { throw new Error("should not run"); } }),
    /eight digits/,
  );
});
