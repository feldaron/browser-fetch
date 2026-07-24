import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnvironment } from "../src/cli.mjs";

test("uses numeric defaults when issue inputs are empty strings", () => {
  const config = configFromEnvironment({
    MODE: "specific-product",
    RETAILER: "currys",
    PRODUCT_URL: "https://www.currys.co.uk/products/example-10296598.html",
    REPEAT_COUNT: "6",
    REQUEST_DELAY_MS: "",
    HEADED: "true",
    SAVE_DEBUG: "false",
  });

  assert.equal(config.repeatCount, 6);
  assert.equal(config.delayMs, 1500);
  assert.equal(config.headed, true);
});
