import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { currysItemNumber } from "./currys.mjs";
import { validateRetailerUrl } from "./security.mjs";

export function currysCataloguePageUrl(baseUrl, pageNumber, pageSize = 20) {
  const url = validateRetailerUrl(baseUrl, "currys");
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("pageNumber must be at least 1");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("pageSize must be from 1 to 100");
  url.searchParams.set("start", String((pageNumber - 1) * pageSize));
  url.searchParams.set("sz", String(pageSize));
  return url.toString();
}

export async function discoverCurrysPage(baseUrl, pageNumber, options = {}) {
  const pageSize = Number(options.pageSize ?? 20);
  const pageUrl = currysCataloguePageUrl(baseUrl, pageNumber, pageSize);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "chrome", headless: options.headed === false });
  const context = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London", viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  try {
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const blocked = [403, 429].includes(response?.status()) || /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check/i.test(bodyText.slice(0, 12000));
    if (blocked) {
      return { status: "blocked", pageNumber, requestedUrl: pageUrl, finalUrl: page.url(), httpStatus: response?.status() ?? null, productUrls: [], conflicts: ["catalogue page was blocked"] };
    }

    const hrefs = await page.locator('a[href*="/products/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href"))).catch(() => []);
    const productUrls = [...new Set(hrefs.filter(Boolean).map((href) => new URL(href, page.url()).toString()).filter((url) => /\/products\/[^?#]+-\d{8}\.html(?:$|[?#])/.test(url)))];
    return {
      status: productUrls.length ? "success" : "failed",
      pageNumber,
      requestedUrl: pageUrl,
      finalUrl: page.url(),
      httpStatus: response?.status() ?? null,
      productUrls,
      retailerItemNumbers: productUrls.map(currysItemNumber),
      discoveredAt: new Date().toISOString(),
      verificationMethod: "literal product-card href discovery only; catalogue-card prices ignored",
      conflicts: productUrls.length ? [] : ["no Currys product-card hrefs were found"],
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function writeCheckpoint(outputDirectory, pageNumber, checkpoint) {
  const checkpointDirectory = path.join(outputDirectory, "checkpoints");
  await mkdir(checkpointDirectory, { recursive: true });
  const filename = path.join(checkpointDirectory, `currys-page-${String(pageNumber).padStart(4, "0")}.json`);
  await writeFile(filename, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

export async function runCatalogue(config) {
  const outputDirectory = config.outputDirectory ?? "results";
  await mkdir(outputDirectory, { recursive: true });
  const pages = [];
  let overallStatus = "success";

  for (let pageNumber = config.startPage; pageNumber <= config.endPage; pageNumber += 1) {
    const discovery = await discoverCurrysPage(config.catalogueUrl, pageNumber, { pageSize: config.pageSize, headed: config.headed });
    const checkpoint = { ...discovery, mode: config.mode, productResults: [], completedProductCount: 0, checkpointedAt: new Date().toISOString() };
    await writeCheckpoint(outputDirectory, pageNumber, checkpoint);

    if (discovery.status !== "success") {
      overallStatus = discovery.status;
      pages.push(checkpoint);
      break;
    }

    if (config.mode === "controlled-crawl") {
      const { verifyProduct } = await import("./runner.mjs");
      for (const productUrl of discovery.productUrls) {
        const itemNumber = currysItemNumber(productUrl);
        const productDirectory = path.join(outputDirectory, `page-${String(pageNumber).padStart(4, "0")}`);
        const result = await verifyProduct({
          url: productUrl,
          expected: { itemNumber, mpn: null, ean: null, price: null },
        }, {
          repeatCount: config.repeatCount,
          headed: config.headed,
          outputDirectory: productDirectory,
          delayMs: config.delayMs,
        });
        const { attempts: _attempts, ...compactResult } = result;
        checkpoint.productResults.push(compactResult);
        checkpoint.completedProductCount += 1;
        checkpoint.checkpointedAt = new Date().toISOString();
        await writeCheckpoint(outputDirectory, pageNumber, checkpoint);
        if (result.status === "blocked") {
          checkpoint.status = "blocked";
          checkpoint.conflicts.push(`blocked while verifying ${productUrl}`);
          overallStatus = "blocked";
          await writeCheckpoint(outputDirectory, pageNumber, checkpoint);
          break;
        }
        if (result.status !== "success" && overallStatus === "success") overallStatus = "conflict";
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
      }
    }

    checkpoint.status = checkpoint.status === "blocked" ? "blocked" : "success";
    checkpoint.completedAt = new Date().toISOString();
    await writeCheckpoint(outputDirectory, pageNumber, checkpoint);
    pages.push(checkpoint);
    if (checkpoint.status === "blocked") break;
  }

  return {
    schemaVersion: 1,
    status: overallStatus,
    eligible: false,
    retailer: "currys",
    mode: config.mode,
    catalogueUrl: config.catalogueUrl,
    startPage: config.startPage,
    endPage: config.endPage,
    pageSize: config.pageSize,
    timestamp: new Date().toISOString(),
    pages,
    note: "Catalogue prices were not used. Product prices, where present, came from individual product pages.",
  };
}
