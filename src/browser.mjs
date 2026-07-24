import { chromium } from "playwright";
import { evaluateCurrysAttempt } from "./currys.mjs";
import { validateRetailerUrl } from "./security.mjs";

async function acceptConsent(page) {
  const candidates = [
    page.getByRole("button", { name: /accept all/i }),
    page.getByRole("button", { name: /accept cookies/i }),
    page.getByRole("button", { name: /^allow all$/i }),
  ];
  for (const locator of candidates) {
    if (await locator.count().catch(() => 0)) {
      await locator.first().click({ timeout: 3000 }).catch(() => undefined);
      return;
    }
  }
}

async function collectPriceElementTexts(page) {
  const selectors = [
    '[data-testid="product-price"]',
    '[data-testid*="product-price" i]',
    '[data-test*="product-price" i]',
    '[data-component*="price" i]',
    '[class*="product-price" i]',
    '[class*="price__current" i]',
    '[class*="ProductPrice" i]',
    'main [itemprop="price"]',
  ];
  const values = [];
  for (const selector of selectors) {
    const texts = await page.locator(selector).allInnerTexts().catch(() => []);
    values.push(...texts);
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 30);
}

export async function launchChrome({ headed = true } = {}) {
  const channel = process.env.BROWSER_CHANNEL ?? "chrome";
  return chromium.launch({
    channel,
    headless: !headed,
    args: ["--disable-dev-shm-usage", "--no-default-browser-check", "--disable-background-networking"],
  });
}

export async function loadCurrysAttempt(browser, target, { captureDebug = false } = {}) {
  const requested = validateRetailerUrl(target.url, "currys");
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1440, height: 1100 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  let response = null;

  try {
    response = await page.goto(requested.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await acceptConsent(page);
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    validateRetailerUrl(finalUrl, "currys");
    const [documentTitle, heading, bodyText, mainText, canonicalUrl, jsonLdTexts, priceElementTexts] = await Promise.all([
      page.title().catch(() => null),
      page.locator("h1").first().innerText({ timeout: 5000 }).catch(() => null),
      page.locator("body").innerText({ timeout: 15000 }).catch(() => ""),
      page.locator("main").first().innerText({ timeout: 15000 }).catch(() => ""),
      page.locator('link[rel="canonical"]').first().getAttribute("href").catch(() => null),
      page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []),
      collectPriceElementTexts(page),
    ]);

    const raw = {
      requestedUrl: requested.toString(),
      finalUrl,
      canonicalUrl: canonicalUrl ? new URL(canonicalUrl, finalUrl).toString() : null,
      httpStatus: response?.status() ?? null,
      documentTitle,
      heading,
      bodyText,
      mainText,
      jsonLdTexts,
      priceElementTexts,
      timestamp: new Date().toISOString(),
      _debug: captureDebug ? { html: await page.content().catch(() => null) } : null,
    };

    const attempt = evaluateCurrysAttempt(raw, target.expected);
    if (captureDebug || attempt.status !== "success") {
      const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
      attempt._debug = { ...(attempt._debug ?? {}), html: raw._debug?.html ?? await page.content().catch(() => null), screenshot };
    }
    return attempt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: /403|429|captcha|access denied/i.test(message) ? "blocked" : "failed",
      requestedUrl: requested.toString(),
      finalUrl: page.url() || null,
      canonicalUrl: null,
      httpStatus: response?.status() ?? null,
      retailerItemNumber: null,
      productTitle: null,
      manufacturer: null,
      modelFamily: null,
      manufacturerSku: null,
      ean: null,
      retailerSku: null,
      cpu: null,
      gpu: null,
      ram: null,
      storage: null,
      display: null,
      colour: null,
      mainPurchasePrice: null,
      mainPurchasePriceText: null,
      deliveryCharge: null,
      effectivePrice: null,
      currency: "GBP",
      availability: null,
      inStock: null,
      structuredOfferPrice: null,
      timestamp: new Date().toISOString(),
      verificationMethod: "headed Google Chrome / isolated Playwright context / navigation failure",
      identityChecks: {},
      conflicts: [message],
      evidenceUrls: [requested.toString()],
      provenance: {},
      _debug: captureDebug ? { html: await page.content().catch(() => null), screenshot: await page.screenshot({ fullPage: true }).catch(() => null) } : null,
    };
  } finally {
    await context.close();
  }
}
