import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCatalogue } from "./catalogue.mjs";
import { verifyProduct } from "./runner.mjs";

function integer(value, fallback, minimum, maximum) {
  const source = value === null || value === undefined || value === "" ? fallback : value;
  const parsed = Number.parseInt(String(source), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Expected integer from ${minimum} to ${maximum}, got ${value}`);
  return parsed;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid numeric value: ${value}`);
  return parsed;
}

function bool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function configFromEnvironment(env = process.env) {
  const mode = env.MODE ?? "specific-product";
  if (!["specific-product", "catalogue-discovery", "controlled-crawl"].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const outputDirectory = env.RESULTS_DIR ?? "results";
  const config = {
    mode,
    retailer: String(env.RETAILER ?? "currys").toLowerCase(),
    outputDirectory,
    headed: bool(env.HEADED, true),
    repeatCount: integer(env.REPEAT_COUNT, mode === "specific-product" ? 3 : 2, 1, 8),
    delayMs: integer(env.REQUEST_DELAY_MS, 1500, 0, 30000),
  };
  if (!["currys", "argos"].includes(config.retailer)) throw new Error(`Unsupported retailer: ${config.retailer}`);

  if (mode === "specific-product") {
    if (!env.PRODUCT_URL) throw new Error("PRODUCT_URL is required in specific-product mode");
    return {
      ...config,
      productUrl: env.PRODUCT_URL,
      expected: {
        itemNumber: env.EXPECTED_ITEM_NUMBER || null,
        mpn: env.EXPECTED_MPN || null,
        ean: env.EXPECTED_EAN || null,
        price: optionalNumber(env.EXPECTED_PRICE),
      },
      captureDebug: bool(env.SAVE_DEBUG, false),
    };
  }

  if (!env.CATALOGUE_URL) throw new Error("CATALOGUE_URL is required in catalogue modes");
  const startPage = integer(env.START_PAGE, 1, 1, 1000);
  const endPage = integer(env.END_PAGE, startPage, startPage, 1000);
  return {
    ...config,
    catalogueUrl: env.CATALOGUE_URL,
    startPage,
    endPage,
    pageSize: integer(env.PAGE_SIZE, 20, 1, 100),
  };
}

export async function runFromConfig(config) {
  await mkdir(config.outputDirectory, { recursive: true });
  let result;
  if (config.mode === "specific-product") {
    result = await verifyProduct({ url: config.productUrl, expected: config.expected }, {
      repeatCount: config.repeatCount,
      headed: config.headed,
      outputDirectory: config.outputDirectory,
      delayMs: config.delayMs,
      captureDebug: config.captureDebug,
      retailer: config.retailer,
    });
  } else {
    result = await runCatalogue(config);
  }
  await writeFile(path.join(config.outputDirectory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function exitCode(status) {
  return status === "success" ? 0 : status === "conflict" ? 2 : status === "blocked" ? 3 : 4;
}

async function main() {
  const result = await runFromConfig(configFromEnvironment());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode(result.status);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 4;
  });
}
