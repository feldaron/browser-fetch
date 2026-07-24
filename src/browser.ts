import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import {
  choosePrice,
  extractBodyIdentifiers,
  extractStructuredData,
  identifierMatches,
  mergeIdentifiers,
  parseVisiblePrices,
} from "./extract.js";
import { isAllowedHostname, validateTargetUrl } from "./security.js";
import type { FetchTarget, PriceCandidate, PriceObservation } from "./types.js";

const BLOCK_TEXT = /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked/i;

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "observation";
}

function inferRetailer(target: FetchTarget, finalUrl: string | null): string {
  if (target.retailer) return target.retailer;
  const hostname = new URL(finalUrl ?? target.url).hostname.replace(/^www\./, "");
  return hostname;
}

async function acceptCommonConsent(page: import("playwright").Page): Promise<void> {
  const buttons = page.getByRole("button", {
    name: /^(accept all|accept cookies|allow all|agree|i agree|continue)$/i,
  });
  if ((await buttons.count()) > 0) {
    await buttons.first().click({ timeout: 2500 }).catch(() => undefined);
  }
}

async function visiblePriceTexts(page: import("playwright").Page): Promise<string[]> {
  const selectors = [
    '[itemprop="price"]',
    '[data-testid*="price" i]',
    '[data-test*="price" i]',
    '[class*="current-price" i]',
    '[class*="product-price" i]',
    '[class~="price" i]',
    '[id*="price" i]',
  ].join(",");
  return page.locator(selectors).allInnerTexts().catch(() => []);
}

async function metaPriceCandidates(page: import("playwright").Page): Promise<PriceCandidate[]> {
  const values = await page
    .locator(
      'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]',
    )
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("content") ?? ""))
    .catch(() => [] as string[]);

  return values.flatMap((text) => {
    const value = Number.parseFloat(text.replace(/,/g, ""));
    return Number.isFinite(value) && value > 0
      ? [{ value, text, source: "meta.price", confidence: 95 }]
      : [];
  });
}

export async function fetchWithBrowser(
  browser: Browser,
  target: FetchTarget,
  outputDirectory = "results",
): Promise<PriceObservation> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const requested = validateTargetUrl(target.url);
  await mkdir(outputDirectory, { recursive: true });

  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 LaptopValuePriceCheck/1.0",
  });
  const page = await context.newPage();

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const navigationUrl = new URL(request.url());
      if (!isAllowedHostname(navigationUrl.hostname)) {
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });

  let finalUrl: string | null = null;
  let httpStatus: number | null = null;
  let title: string | null = null;
  let screenshotFile: string | null = null;

  try {
    const response = await page.goto(requested.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    httpStatus = response?.status() ?? null;
    await acceptCommonConsent(page);
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

    finalUrl = page.url();
    validateTargetUrl(finalUrl);
    title = await page.title();
    const bodyText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");

    const screenshotName = `${safeFilePart(target.id ?? new URL(target.url).hostname)}-${runId}.png`;
    screenshotFile = path.join(outputDirectory, screenshotName);
    await page.screenshot({ path: screenshotFile, fullPage: true }).catch(() => {
      screenshotFile = null;
    });

    const jsonLdTexts = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents()
      .catch(() => []);
    const structured = extractStructuredData(jsonLdTexts);
    const bodyIdentifiers = extractBodyIdentifiers(bodyText);
    const identifiers = mergeIdentifiers(structured.identifiers, bodyIdentifiers);
    const candidates = [
      ...structured.priceCandidates,
      ...(await metaPriceCandidates(page)),
      ...parseVisiblePrices(await visiblePriceTexts(page)),
    ];
    const chosen = choosePrice(candidates);
    const match = identifierMatches(target.expectedSku, target.expectedEan, identifiers, `${title}\n${bodyText}`);
    const blocked = BLOCK_TEXT.test(`${title}\n${bodyText.slice(0, 8000)}`) || httpStatus === 403 || httpStatus === 429;

    const status = blocked
      ? "blocked"
      : match === false
        ? "identifier_mismatch"
        : chosen
          ? "ok"
          : "price_not_found";

    return {
      runId,
      targetId: target.id ?? null,
      retailer: inferRetailer(target, finalUrl),
      requestedUrl: requested.toString(),
      finalUrl,
      observedAt: new Date().toISOString(),
      status,
      accepted: status === "ok",
      httpStatus,
      title,
      currency: "GBP",
      price: chosen?.value ?? null,
      priceText: chosen?.text ?? null,
      availability: structured.availability,
      expectedSku: target.expectedSku ?? null,
      expectedEan: target.expectedEan ?? null,
      identifierMatch: match,
      identifiers,
      priceCandidates: candidates.slice(0, 25),
      screenshotFile,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      runId,
      targetId: target.id ?? null,
      retailer: inferRetailer(target, finalUrl),
      requestedUrl: requested.toString(),
      finalUrl,
      observedAt: new Date().toISOString(),
      status: /timeout|navigation|net::/i.test(message) ? "navigation_error" : "error",
      accepted: false,
      httpStatus,
      title,
      currency: "GBP",
      price: null,
      priceText: null,
      availability: null,
      expectedSku: target.expectedSku ?? null,
      expectedEan: target.expectedEan ?? null,
      identifierMatch: null,
      identifiers: { sku: [], ean: [], mpn: [] },
      priceCandidates: [],
      screenshotFile,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    await context.close();
  }
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}
