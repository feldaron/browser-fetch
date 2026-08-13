import { pathToFileURL } from "node:url";

const CURRYS_HOSTS = new Set(["currys.co.uk", "www.currys.co.uk"]);
const ITEM = /-(\d{8})\.html$/;
const BLOCK = /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked|sorry,? you have been blocked|you have been blocked/i;

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&pound;/gi, "£")
    .trim();
}

function firstMatch(html, pattern) {
  const match = String(html ?? "").match(pattern);
  return match?.[1] ? decodeHtml(match[1].replace(/<[^>]*>/g, " ")) : null;
}

function itemNumber(url) {
  try {
    return new URL(url).pathname.match(ITEM)?.[1] ?? null;
  } catch {
    return null;
  }
}

function validateProductUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !CURRYS_HOSTS.has(url.hostname.toLowerCase()) || !ITEM.test(url.pathname)) {
    throw new Error("Expected an HTTPS Currys consumer product URL ending in an eight-digit item number");
  }
  url.hash = "";
  return url;
}

function jsonLdBlocks(html) {
  return [...String(html ?? "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => decodeHtml(match[1]))
    .filter(Boolean);
}

function objects(value) {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(objects)];
}

function types(value) {
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry).toLowerCase());
}

function parseProduct(html) {
  const parsed = [];
  const errors = [];
  for (const block of jsonLdBlocks(html)) {
    try {
      parsed.push(JSON.parse(block));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const all = parsed.flatMap(objects);
  const product = all.find((entry) => types(entry["@type"]).includes("product")) ?? null;
  const offerCandidates = product ? objects(product.offers) : [];
  const offer = offerCandidates.find((entry) => types(entry["@type"]).some((type) => type === "offer" || type === "aggregateoffer"))
    ?? all.find((entry) => types(entry["@type"]).some((type) => type === "offer" || type === "aggregateoffer"))
    ?? null;
  const priceValue = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price ?? null;
  const price = priceValue === null ? null : Number(String(priceValue).replace(/,/g, ""));
  return {
    productName: product?.name ? decodeHtml(product.name) : null,
    sku: product?.sku ? String(product.sku) : null,
    mpn: product?.mpn ? String(product.mpn) : null,
    gtin: product?.gtin13 ?? product?.gtin ?? product?.gtin14 ?? product?.gtin12 ?? null,
    price: Number.isFinite(price) ? price : null,
    currency: offer?.priceCurrency ? String(offer.priceCurrency).toUpperCase() : null,
    availability: offer?.availability ? String(offer.availability) : null,
    jsonLdParseErrors: errors,
  };
}

function stockState(availability) {
  if (!availability) return null;
  const state = String(availability).split("/").pop().toLowerCase();
  if (["instock", "limitedavailability", "onlineonly"].includes(state)) return true;
  if (["outofstock", "soldout", "discontinued"].includes(state)) return false;
  return null;
}

export function extractCurrysHttpEvidence(html, requestedUrl, finalUrl = requestedUrl, httpStatus = 200) {
  const requested = validateProductUrl(requestedUrl);
  const final = validateProductUrl(finalUrl);
  const canonical = firstMatch(html, /<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])(?=[^>]*\bhref\s*=\s*["']([^"']+)["'])[^>]*>/i)
    ?? firstMatch(html, /<link\b(?=[^>]*\bhref\s*=\s*["']([^"']+)["'])(?=[^>]*\brel\s*=\s*["']canonical["'])[^>]*>/i);
  const canonicalUrl = canonical ? new URL(canonical, final).toString() : null;
  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const heading = firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const structured = parseProduct(html);
  const blocked = [403, 429].includes(httpStatus) || BLOCK.test([title, heading, String(html).slice(0, 12000)].filter(Boolean).join("\n"));
  const requestedItem = itemNumber(requested);
  const finalItem = itemNumber(final);
  const canonicalItem = itemNumber(canonicalUrl);
  const structuredItem = structured.sku && /^\d{8}$/.test(structured.sku) ? structured.sku : null;
  const foundItem = canonicalItem ?? structuredItem ?? finalItem;
  const conflicts = [];
  if (blocked) conflicts.push("Currys or its security provider returned a block page");
  if (requestedItem !== finalItem) conflicts.push(`redirect changed item number from ${requestedItem} to ${finalItem}`);
  if (!canonicalUrl || canonicalItem !== requestedItem) conflicts.push("canonical URL does not confirm the requested item number");
  if (structuredItem && structuredItem !== requestedItem) conflicts.push(`structured SKU ${structuredItem} disagrees with requested item ${requestedItem}`);
  if (structured.currency !== "GBP") conflicts.push("structured offer currency is not GBP");
  if (structured.price === null || structured.price < 20) conflicts.push("no plausible structured product price was published");
  const inStock = stockState(structured.availability);
  if (inStock === null) conflicts.push("availability is missing or not a decisive stock state");
  if (!structured.productName) conflicts.push("structured product identity is missing");
  return {
    schemaVersion: 1,
    status: blocked ? "blocked" : conflicts.length ? "conflict" : "success",
    eligible: !blocked && conflicts.length === 0,
    requestedUrl: requested.toString(),
    finalUrl: final.toString(),
    canonicalUrl,
    httpStatus,
    retailerItemNumber: foundItem,
    productTitle: structured.productName ?? heading ?? title,
    manufacturerSku: structured.mpn,
    ean: structured.gtin ? String(structured.gtin) : null,
    mainPurchasePrice: structured.price,
    currency: structured.currency,
    availability: structured.availability,
    inStock,
    timestamp: new Date().toISOString(),
    verificationMethod: "cookie-free HTTPS GET / Currys product JSON-LD / canonical identity",
    conflicts,
    provenance: {
      price: "Product.offers.price or lowPrice",
      availability: "Product.offers.availability",
      identity: "product URL + canonical URL + Product.sku when published",
      browserUsed: false,
      authenticationUsed: false,
    },
    jsonLdParseErrors: structured.jsonLdParseErrors,
  };
}

export async function probeCurrysProduct(url, options = {}) {
  const requested = validateProductUrl(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(requested, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.8",
      "Cache-Control": "no-cache",
      "User-Agent": "LaptopValuePriceMonitor/1.0 (+https://www.laptopvalue.co.uk)",
    },
  });
  const final = validateProductUrl(response.url || requested.toString());
  const html = await response.text();
  return extractCurrysHttpEvidence(html, requested.toString(), final.toString(), response.status);
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer from ${min} to ${max}`);
  return parsed;
}

export async function runRepeatedProbe(url, options = {}) {
  const repeatCount = integer(String(options.repeatCount ?? ""), 3, 1, 5);
  const delayMs = integer(String(options.delayMs ?? ""), 1500, 0, 10000);
  const attempts = [];
  for (let index = 0; index < repeatCount; index += 1) {
    attempts.push(await probeCurrysProduct(url, options));
    if (attempts.at(-1).status === "blocked") break;
    if (index + 1 < repeatCount) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const fingerprints = new Set(attempts.map((attempt) => JSON.stringify([
    attempt.retailerItemNumber,
    attempt.mainPurchasePrice,
    attempt.currency,
    attempt.availability,
    attempt.inStock,
    attempt.canonicalUrl,
  ])));
  const allSuccessful = attempts.length === repeatCount && attempts.every((attempt) => attempt.status === "success");
  const conflicts = [...new Set(attempts.flatMap((attempt) => attempt.conflicts))];
  if (fingerprints.size > 1) conflicts.push("repeated HTTP readings disagree");
  const exemplar = attempts.at(-1);
  return {
    ...exemplar,
    status: allSuccessful && fingerprints.size === 1 ? "success" : attempts.some((attempt) => attempt.status === "blocked") ? "blocked" : "conflict",
    eligible: allSuccessful && fingerprints.size === 1,
    attempts,
    conflicts,
    repeatCountRequested: repeatCount,
    repeatCountCompleted: attempts.length,
  };
}

async function main() {
  const url = process.env.PRODUCT_URL;
  if (!url) throw new Error("PRODUCT_URL is required");
  const result = await runRepeatedProbe(url, {
    repeatCount: process.env.REPEAT_COUNT,
    delayMs: process.env.REQUEST_DELAY_MS,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "success" ? 0 : result.status === "blocked" ? 3 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 4;
  });
}
