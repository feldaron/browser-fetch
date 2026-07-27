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
const BLOCK_PAGE_PATTERN = /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked|sorry,? you have been blocked|you have been blocked/i;

export function currysItemNumber(url) {
  if (!url) return null;
  const pathname = new URL(url).pathname;
  return pathname.match(/-(\d{8})\.html$/)?.[1]
    ?? pathname.match(/\/([A-Z]\d{6}[A-Z])$/i)?.[1]?.toUpperCase()
    ?? pathname.match(ITEM_NUMBER_PATTERN)?.[1]
    ?? null;
}

export function isCurrysBlockPage(...values) {
  return BLOCK_PAGE_PATTERN.test(values.filter(Boolean).join("\n"));
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text ?? "").match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return null;
}

function titleIdentityDetails(title) {
  const titleText = String(title ?? "");
  const cpu = firstMatch(titleText, [
    /\b((?:Intel®?\s+)?Core(?:™)?\s+Ultra\s+[A-Z]?\d(?:\s+\d{3,4}[A-Z]*)?)\b/i,
    /\b((?:Intel®?\s+)?Core(?:™)?\s+\d(?:\s+\d{3,4}[A-Z]*)?)\b/i,
    /\b(AMD\s+Ryzen(?:™)?\s+(?:AI\s+)?\d(?:\s+\d{3,4}[A-Z]*)?)\b/i,
    /\b(Snapdragon\s+X(?:2)?(?:\s+(?:Elite|Plus))?(?:\s+[A-Z0-9-]+)?)\b/i,
  ]);
  const storage = firstMatch(titleText, [/\b((?:\d+(?:\.\d+)?)\s*(?:TB|GB)\s*(?:SSD|UFS))\b/i]);
  const screenSize = firstMatch(titleText, [/\b(\d{2}(?:\.\d)?["”])\s*(?:Laptop|Gaming Laptop|2 in 1)?/i]);
  const colour = firstMatch(titleText, [/[-,]\s*([A-Za-z][A-Za-z ]{2,30})$/]);
  const evidence = [
    cpu ? "title-cpu" : null,
    storage ? "title-storage" : null,
    screenSize ? "title-screen-size" : null,
    colour ? "title-colour" : null,
  ].filter(Boolean);
  return { cpu, storage, screenSize, colour, evidence };
}

export function extractCurrysSpecs(title, bodyText, structured = {}) {
  const titleText = String(title ?? "");
  const body = String(bodyText ?? "");
  const text = `${titleText}\n${body}`;
  const titleIdentity = titleIdentityDetails(titleText);
  const businessMpn = firstMatch(text, [/Product code:\s*[A-Z]\d{6}[A-Z]\s*\|\s*([A-Z0-9#._/-]+)/i]);
  const mpn = structured.identifiers?.mpn
    ?? businessMpn
    ?? findIdentifier(text, ["Manufacturer's Part Number", "Manufacturer SKU", "MPN", "Box contents"]);
  const ean = structured.identifiers?.ean
    ?? findIdentifier(text, ["EAN", "GTIN", "Barcode"], /\d{8,14}/);
  const sku = structured.identifiers?.sku ?? null;

  const ram = labelledValue(body, ["RAM"])
    ?? firstMatch(body, [/RAM:\s*([^/\n]{2,50})/i, /\b(\d{1,3}\s*GB\s*(?:LPDDR\w*|DDR\w*)?)\b/i]);
  const storage = titleIdentity.storage
    ?? labelledValue(body, ["Storage"])
    ?? firstMatch(body, [/Storage:\s*([^\n]{2,60})/i, /\b((?:\d+(?:\.\d+)?)\s*(?:TB|GB)\s*(?:SSD|UFS))\b/i]);
  const cpu = titleIdentity.cpu
    ?? labelledValue(body, ["Processor"])
    ?? firstMatch(body, [
      /\b((?:Intel®?\s+)?Core(?:™)?\s+Ultra\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
      /\b(AMD\s+Ryzen(?:™)?\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
      /\b(Snapdragon\s+X\s+[A-Za-z0-9 -]{1,40}?)(?:\s+processor|\n|,)/i,
    ]);
  const gpu = labelledValue(body, ["Graphics", "GPU"])
    ?? firstMatch(body, [/(NVIDIA\s+GeForce\s+RTX\s+\d{4}(?:\s+Ti)?[^\n,]*)/i, /(AMD\s+Radeon[^\n,]*)/i, /(Intel\s+Arc[^\n,]*)/i]);
  const screenSize = titleIdentity.screenSize
    ?? labelledValue(body, ["Screen size"])
    ?? firstMatch(body, [/\b(\d{2}(?:\.\d)?["”])\b/i]);
  const screenType = labelledValue(body, ["Screen type"])
    ?? firstMatch(body, [/\b(OLED|Mini LED|IPS|TN)\b/i]);
  const resolution = labelledValue(body, ["Resolution"])
    ?? firstMatch(body, [/\b((?:Full HD\+?|Quad HD\+?|2\.8K|3K|4K)(?:\s+\d{3,4}\s*x\s*\d{3,4}p?)?)\b/i]);
  const refreshRate = firstMatch(body, [/\b(\d{2,3}\s*Hz)\b/i]);
  const colour = titleIdentity.colour
    ?? labelledValue(body, ["Colour"]);

  const manufacturer = structured.manufacturer
    ?? firstMatch(titleText, [/^([A-Z][A-Z0-9]+)/]);
  const modelFamily = cleanText((titleText || structured.productName || "").replace(/^([A-Z][A-Z0-9]+)\s+/i, "").split(" - ")[0]);

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
    _identityEvidence: titleIdentity.evidence,
  };
}

export function extractCurrysMainPrice(mainText, priceElementTexts = []) {
  const combinedText = [mainText, ...priceElementTexts].filter(Boolean).join("\n");
  const incVatMatch = combinedText.match(/£\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{2})?)\s*inc\s+VAT/i);
  if (incVatMatch) {
    const value = Number.parseFloat(incVatMatch[1].replace(/,/g, ""));
    const exVatMatch = combinedText.match(/£\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{2})?)\s*ex\s+VAT/i);
    const exVatValue = exVatMatch ? Number.parseFloat(exVatMatch[1].replace(/,/g, "")) : null;
    if (Number.isFinite(value) && value >= 20) {
      return { value, text: incVatMatch[0], method: "business-inc-vat", exVatValue };
    }
  }

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
  const business = new URL(raw.requestedUrl).hostname.toLowerCase() === "business.currys.co.uk";
  const title = cleanText(raw.heading) ?? cleanText(structured.productName) ?? cleanText(raw.documentTitle);
  const canonicalUrl = raw.canonicalUrl ?? raw.finalUrl;
  const requestedItem = currysItemNumber(raw.requestedUrl);
  const finalItem = currysItemNumber(raw.finalUrl);
  const canonicalItem = currysItemNumber(canonicalUrl);
  const itemNumber = canonicalItem ?? finalItem ?? requestedItem;
  const mainPrice = extractCurrysMainPrice(raw.mainText, raw.priceElementTexts);
  const extractedSpecs = extractCurrysSpecs(title, raw.bodyText, structured);
  const { _identityEvidence: titleIdentityEvidence, ...specs } = extractedSpecs;
  const delivery = extractCurrysDelivery(raw.mainText, mainPrice?.value ?? null);
  const effectivePrice = mainPrice && delivery.charge !== null ? mainPrice.value + delivery.charge : mainPrice?.value ?? null;
  const inStock = deriveInStock(structured.availability, raw.mainText);
  const conflicts = [];

  if (mainPrice && structured.structuredPrice !== null) {
    const structuredMatchesIncVat = Math.abs(mainPrice.value - structured.structuredPrice) <= 0.02;
    const structuredMatchesExVat = business
      && typeof mainPrice.exVatValue === "number"
      && Math.abs(mainPrice.exVatValue - structured.structuredPrice) <= 0.02;
    if (!structuredMatchesIncVat && !structuredMatchesExVat) {
      conflicts.push(`VAT-inclusive main price £${mainPrice.value.toFixed(2)} disagrees with structured price £${structured.structuredPrice.toFixed(2)}`);
    }
  }
  if (business && mainPrice && typeof mainPrice.exVatValue === "number") {
    const calculatedIncVat = Math.round(mainPrice.exVatValue * 1.2 * 100) / 100;
    if (Math.abs(calculatedIncVat - mainPrice.value) > 0.02) {
      conflicts.push(`published inc-VAT price £${mainPrice.value.toFixed(2)} is not 20% above ex-VAT price £${mainPrice.exVatValue.toFixed(2)}`);
    }
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

  const blocked = [403, 429].includes(raw.httpStatus) || isCurrysBlockPage(raw.documentTitle, raw.heading, raw.bodyText?.slice(0, 12000), raw.mainText?.slice(0, 12000));
  if (blocked) conflicts.push("retailer block page detected; product evidence quarantined");
  let status = "success";
  if (blocked) status = "blocked";
  else if (conflicts.length) status = "conflict";
  else if (!mainPrice || !title || !itemNumber) status = "failed";

  const itemNumberConfirmed = expected.itemNumber
    ? itemNumber === String(expected.itemNumber)
    : Boolean(itemNumber && requestedItem === itemNumber && (!canonicalItem || canonicalItem === itemNumber));
  const canonicalConfirmed = Boolean(canonicalItem && canonicalItem === itemNumber);
  const strongIdentity = Boolean(
    !blocked
      && itemNumberConfirmed
      && canonicalConfirmed
      && title
      && ((specs.manufacturerSku || specs.ean) || titleIdentityEvidence.length >= 2),
  );
  if (status === "success" && !strongIdentity) {
    status = "conflict";
    conflicts.push("identity is insufficient: confirm the retailer item, canonical product URL and at least two title-derived configuration details or an MPN/EAN");
  }
  const identityBasis = [
    itemNumberConfirmed ? "retailer-item-number" : null,
    canonicalConfirmed ? "canonical-item-number" : null,
    title ? "product-title" : null,
    specs.manufacturerSku ? "manufacturer-sku" : null,
    specs.ean ? "ean" : null,
    ...titleIdentityEvidence,
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
    exVatPrice: mainPrice?.exVatValue ?? null,
    vatIncluded: business ? true : null,
    deliveryCharge: delivery.charge,
    effectivePrice,
    currency: structured.structuredCurrency === "GBP" || !structured.structuredCurrency ? "GBP" : structured.structuredCurrency,
    availability: structured.availability,
    inStock,
    structuredOfferPrice: structured.structuredPrice,
    timestamp: raw.timestamp,
    verificationMethod: business
      ? "headed Google Chrome / isolated Playwright context / Currys Business VAT-inclusive purchase block"
      : "headed Google Chrome / isolated Playwright context / Currys main purchase block",
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
      priceBasis: business ? "published-inc-vat" : "published-consumer-price",
      structuredPrice: structured.offerSource ?? "not-found",
      delivery: delivery.method,
      canonical: raw.canonicalUrl ? "link[rel=canonical]" : "final-url-fallback",
      jsonLdParseErrorCount: structured.parseErrors.length,
      specificationScope: "title-derived configuration used for identity; broad body specifications are informational only",
    },
    _debug: raw._debug ?? null,
  };
}

export function identityFingerprint(attempt) {
  return [
    attempt.retailerItemNumber,
    normalizeIdentifier(attempt.productTitle),
    normalizeIdentifier(attempt.manufacturerSku),
    normalizeIdentifier(attempt.ean),
    normalizeIdentifier(attempt.canonicalUrl),
  ].join("|");
}
