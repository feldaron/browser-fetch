import {
  cleanText,
  deriveInStock,
  extractStandalonePrice,
  findIdentifier,
  identityMatches,
  labelledValue,
  parseJsonLdTexts,
} from "./extract.mjs";
import { normalizeIdentifier } from "./security.mjs";

const ITEM_NUMBER_PATTERN = /(?:-|\/)(\d{8})(?:\.html)?(?:$|[?#/])/;

export function currysItemNumber(url) {
  if (!url) return null;
  const pathname = new URL(url).pathname;
  return pathname.match(/-(\d{8})\.html$/)?.[1] ?? pathname.match(ITEM_NUMBER_PATTERN)?.[1] ?? null;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return null;
}

export function extractCurrysSpecs(title, bodyText, structured = {}) {
  const text = `${title ?? ""}\n${bodyText ?? ""}`;
  const mpn = structured.identifiers?.mpn
    ?? findIdentifier(text, ["Manufacturer's Part Number", "Manufacturer SKU", "MPN", "Box contents"]);
  const ean = structured.identifiers?.ean
    ?? findIdentifier(text, ["EAN", "GTIN", "Barcode"], /\d{8,14}/);
  const sku = structured.identifiers?.sku ?? null;

  const ram = labelledValue(text, ["RAM"])
    ?? firstMatch(text, [/RAM:\s*([^/\n]{2,50})/i, /\b(\d{1,3}\s*GB\s*(?:LPDDR\w*|DDR\w*)?)\b/i]);
  const storage = labelledValue(text, ["Storage"])
    ?? firstMatch(text, [/Storage:\s*([^\n]{2,60})/i, /\b((?:\d+(?:\.\d+)?)\s*(?:TB|GB)\s*SSD)\b/i]);
  const cpu = labelledValue(text, ["Processor"])
    ?? firstMatch(text, [
      /\b((?:Intel®?\s+)?Core(?:™)?\s+Ultra\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
      /\b(AMD\s+Ryzen(?:™)?\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
      /\b(Snapdragon\s+X\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
    ]);
  const gpu = labelledValue(text, ["Graphics", "GPU"])
    ?? firstMatch(text, [/(NVIDIA\s+GeForce\s+RTX\s+\d{4}(?:\s+Ti)?[^\n,]*)/i, /(AMD\s+Radeon[^\n,]*)/i, /(Intel\s+Arc[^\n,]*)/i]);
  const screenSize = labelledValue(text, ["Screen size"])
    ?? firstMatch(title ?? "", [/\b(\d{2}(?:\.\d)?["”]\s*(?:Laptop|Gaming Laptop|2 in 1)?)\b/i]);
  const screenType = labelledValue(text, ["Screen type"])
    ?? firstMatch(text, [/\b(OLED|Mini LED|IPS|TN)\b/i]);
  const resolution = labelledValue(text, ["Resolution"])
    ?? firstMatch(text, [/\b((?:Full HD\+?|Quad HD\+?|2\.8K|3K|4K)(?:\s+\d{3,4}\s*x\s*\d{3,4}p?)?)\b/i]);
  const refreshRate = firstMatch(text, [/\b(\d{2,3}\s*Hz)\b/i]);
  const colour = labelledValue(text, ["Colour"])
    ?? firstMatch(title ?? "", [/[-,]\s*([A-Za-z][A-Za-z ]{2,30})$/]);

  const manufacturer = structured.manufacturer
    ?? firstMatch(title ?? "", [/^([A-Z][A-Z0-9]+)/]);
  const modelFamily = cleanText((title ?? structured.productName ?? "").replace(/^([A-Z][A-Z0-9]+)\s+/i, "").split(" - ")[0]);

  return {
    manufacturer,
    modelFamily,
    manufacturerSku: mpn,
    ean,
    retailerSku: sku,
    cpu,
    gpu,
    ram,
    storage,
    display: cleanText([screenSize, screenType, resolution, refreshRate].filter(Boolean).join(" / ")),
    colour,
  };
}

export function extractCurrysMainPrice(mainText, priceElementTexts = []) {
  const elementPrice = extractStandalonePrice(priceElementTexts.flatMap((value) => String(value).split(/\r?\n/)));
  if (elementPrice) return { ...elementPrice, method: "main-purchase-price-element" };

  const lines = String(mainText).split(/\r?\n/);
  const cutoff = lines.findIndex((line) => /Deals\s*&\s*offers|Product information|Frequently bought/i.test(line));
  const purchaseLines = cutoff > 0 ? lines.slice(0, cutoff) : lines.slice(0, 220);
  const textPrice = extractStandalonePrice(purchaseLines);
  return textPrice ? { ...textPrice, method: "main-purchase-text" } : null;
}

export function extractCurrysDelivery(mainText, price) {
  const text = String(mainText);
  if (/Standard Delivery[\s\S]{0,300}(?:Order over £40:\s*)?FREE/i.test(text)) {
    return { charge: 0, method: "standard-delivery-free" };
  }
  const match = text.match(/Standard Delivery[\s\S]{0,300}?£\s?([0-9]+(?:\.\d{2})?)/i);
  if (match) return { charge: Number.parseFloat(match[1]), method: "standard-delivery-text" };
  if (typeof price === "number" && price >= 40 && /Order over £40:\s*FREE/i.test(text)) {
    return { charge: 0, method: "retailer-threshold-text" };
  }
  return { charge: null, method: "not-found" };
}

export function evaluateCurrysAttempt(raw, expected = {}) {
  const structured = parseJsonLdTexts(raw.jsonLdTexts ?? []);
  const title = cleanText(raw.heading) ?? cleanText(structured.productName) ?? cleanText(raw.documentTitle);
  const canonicalUrl = raw.canonicalUrl ?? raw.finalUrl;
  const requestedItem = currysItemNumber(raw.requestedUrl);
  const finalItem = currysItemNumber(raw.finalUrl);
  const canonicalItem = currysItemNumber(canonicalUrl);
  const itemNumber = canonicalItem ?? finalItem ?? requestedItem;
  const mainPrice = extractCurrysMainPrice(raw.mainText, raw.priceElementTexts);
  const specs = extractCurrysSpecs(title, raw.bodyText, structured);
  const delivery = extractCurrysDelivery(raw.mainText, mainPrice?.value ?? null);
  const effectivePrice = mainPrice && delivery.charge !== null ? mainPrice.value + delivery.charge : mainPrice?.value ?? null;
  const inStock = deriveInStock(structured.availability, raw.mainText);
  const conflicts = [];

  if (mainPrice && structured.structuredPrice !== null && Math.abs(mainPrice.value - structured.structuredPrice) > 0.009) {
    conflicts.push(`main price £${mainPrice.value.toFixed(2)} disagrees with structured price £${structured.structuredPrice.toFixed(2)}`);
  }
  if (requestedItem && finalItem && requestedItem !== finalItem && finalItem !== canonicalItem) {
    conflicts.push(`redirect changed retailer item number from ${requestedItem} to ${finalItem}`);
  }
  if (expected.itemNumber && itemNumber !== String(expected.itemNumber)) {
    conflicts.push(`expected Currys item ${expected.itemNumber}, found ${itemNumber ?? "unknown"}`);
  }
  const bodyIdentity = normalizeIdentifier(raw.bodyText);
  const mpnValues = [specs.manufacturerSku, structured.identifiers.mpn].filter(Boolean);
  const eanValues = [specs.ean, structured.identifiers.ean].filter(Boolean);
  const mpnInBody = expected.mpn ? bodyIdentity.includes(normalizeIdentifier(expected.mpn)) : false;
  const eanInBody = expected.ean ? bodyIdentity.includes(normalizeIdentifier(expected.ean)) : false;
  const mpnPublished = mpnInBody || mpnValues.length > 0;
  const eanPublished = eanInBody || eanValues.length > 0;
  const mpnMatch = !expected.mpn ? null : mpnInBody ? true : mpnValues.length ? identityMatches(expected.mpn, mpnValues) : null;
  const eanMatch = !expected.ean ? null : eanInBody ? true : eanValues.length ? identityMatches(expected.ean, eanValues) : null;
  if (mpnMatch === false) conflicts.push(`published MPN disagrees with expected ${expected.mpn}`);
  if (eanMatch === false) conflicts.push(`published EAN disagrees with expected ${expected.ean}`);
  if (expected.price !== null && expected.price !== undefined && mainPrice && Math.abs(mainPrice.value - Number(expected.price)) > 0.009) {
    conflicts.push(`expected price £${Number(expected.price).toFixed(2)}, found £${mainPrice.value.toFixed(2)}`);
  }

  const blockText = `${raw.documentTitle ?? ""}\n${raw.bodyText?.slice(0, 12000) ?? ""}`;
  const blocked = [403, 429].includes(raw.httpStatus) || /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked/i.test(blockText);
  let status = "success";
  if (blocked) status = "blocked";
  else if (conflicts.length) status = "conflict";
  else if (!mainPrice || !title || !itemNumber) status = "failed";

  const configurationEvidence = [specs.cpu, specs.ram, specs.storage, specs.display, specs.colour].filter(Boolean);
  const itemNumberConfirmed = expected.itemNumber
    ? itemNumber === String(expected.itemNumber)
    : Boolean(itemNumber && requestedItem === itemNumber && (!canonicalItem || canonicalItem === itemNumber));
  const canonicalConfirmed = Boolean(canonicalItem && canonicalItem === itemNumber);
  const strongIdentity = Boolean(
    itemNumberConfirmed
      && canonicalConfirmed
      && title
      && ((specs.manufacturerSku || specs.ean) || configurationEvidence.length >= 2),
  );
  if (status === "success" && !strongIdentity) {
    status = "conflict";
    conflicts.push("identity is insufficient: confirm the retailer item, canonical product URL and at least two configuration details or an MPN/EAN");
  }
  const identityBasis = [
    itemNumberConfirmed ? "retailer-item-number" : null,
    canonicalConfirmed ? "canonical-item-number" : null,
    title ? "product-title" : null,
    specs.manufacturerSku ? "manufacturer-sku" : null,
    specs.ean ? "ean" : null,
    specs.cpu ? "cpu" : null,
    specs.ram ? "ram" : null,
    specs.storage ? "storage" : null,
    specs.display ? "display" : null,
    specs.colour ? "colour" : null,
  ].filter(Boolean);

  return {
    status,
    requestedUrl: raw.requestedUrl,
    finalUrl: raw.finalUrl,
    canonicalUrl,
    httpStatus: raw.httpStatus,
    retailerItemNumber: itemNumber,
    productTitle: title,
    ...specs,
    mainPurchasePrice: mainPrice?.value ?? null,
    mainPurchasePriceText: mainPrice?.text ?? null,
    deliveryCharge: delivery.charge,
    effectivePrice,
    currency: structured.structuredCurrency === "GBP" || !structured.structuredCurrency ? "GBP" : structured.structuredCurrency,
    availability: structured.availability,
    inStock,
    structuredOfferPrice: structured.structuredPrice,
    timestamp: raw.timestamp,
    verificationMethod: "headed Google Chrome / isolated Playwright context / Currys main purchase block",
    identityChecks: {
      expectedItemNumber: expected.itemNumber ?? null,
      itemNumberMatch: expected.itemNumber ? itemNumber === String(expected.itemNumber) : null,
      expectedMpn: expected.mpn ?? null,
      mpnPublished,
      mpnMatch,
      expectedEan: expected.ean ?? null,
      eanPublished,
      eanMatch,
      strongIdentity,
      identityBasis,
    },
    conflicts,
    evidenceUrls: [...new Set([raw.requestedUrl, raw.finalUrl, canonicalUrl].filter(Boolean))],
    provenance: {
      mainPrice: mainPrice?.method ?? "not-found",
      structuredPrice: structured.offerSource ?? "not-found",
      delivery: delivery.method,
      canonical: raw.canonicalUrl ? "link[rel=canonical]" : "final-url-fallback",
      jsonLdParseErrorCount: structured.parseErrors.length,
    },
    _debug: raw._debug ?? null,
  };
}

export function identityFingerprint(attempt) {
  return [
    attempt.retailerItemNumber,
    normalizeIdentifier(attempt.manufacturerSku),
    normalizeIdentifier(attempt.ean),
    normalizeIdentifier(attempt.cpu),
    normalizeIdentifier(attempt.ram),
    normalizeIdentifier(attempt.storage),
    normalizeIdentifier(attempt.display),
    normalizeIdentifier(attempt.colour),
  ].join("|");
}
