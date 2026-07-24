import { normalizeIdentifier } from "./security.mjs";

export function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.replace(/\u00a0/g, " ").match(/(?:£|GBP\s*)?\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function records(value) {
  if (Array.isArray(value)) return value.flatMap(records);
  return value && typeof value === "object" ? [value] : [];
}

function walkRecords(value, output = []) {
  for (const record of records(value)) {
    output.push(record);
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") walkRecords(child, output);
    }
  }
  return output;
}

function typeIncludes(record, expected) {
  const type = record?.["@type"];
  return type === expected || (Array.isArray(type) && type.includes(expected));
}

function stringValue(value) {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && typeof value.name === "string") return value.name.trim() || null;
  return null;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = stringValue(record?.[key]);
    if (value) return value;
  }
  return null;
}

export function parseJsonLdTexts(texts) {
  const products = [];
  const offers = [];
  const parseErrors = [];

  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      for (const record of walkRecords(parsed)) {
        if (typeIncludes(record, "Product")) products.push(record);
        if (typeIncludes(record, "Offer") || typeIncludes(record, "AggregateOffer")) offers.push(record);
      }
    } catch (error) {
      parseErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const product = products[0] ?? null;
  const productOffers = product ? records(product.offers) : [];
  const allOffers = [...productOffers, ...offers];
  let structuredPrice = null;
  let structuredCurrency = null;
  let availability = null;
  let offerSource = null;

  for (const offer of allOffers) {
    for (const key of ["price", "lowPrice"]) {
      const parsed = parseMoney(offer[key]);
      if (parsed !== null && parsed >= 20 && parsed <= 50000) {
        structuredPrice = parsed;
        structuredCurrency = firstString(offer, ["priceCurrency"]) ?? structuredCurrency;
        availability = firstString(offer, ["availability"])?.split("/").at(-1) ?? availability;
        offerSource = `jsonld.${key}`;
        break;
      }
    }
    if (structuredPrice !== null) break;
  }

  const identifiers = {
    sku: firstString(product, ["sku", "productID"]),
    mpn: firstString(product, ["mpn", "model"]),
    ean: firstString(product, ["gtin13", "gtin", "gtin14", "gtin12", "gtin8"]),
  };

  return {
    productName: firstString(product, ["name"]),
    manufacturer: firstString(product, ["brand", "manufacturer"]),
    identifiers,
    structuredPrice,
    structuredCurrency,
    availability,
    offerSource,
    parseErrors,
  };
}

export function extractCanonicalFromHtml(html) {
  const match = String(html).match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    ?? String(html).match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  return match?.[1] ?? null;
}

export function extractStandalonePrice(lines, minimum = 20) {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /per month|monthly|save\s|was\s|credit|apr|trade.?in|from\s+£/i.test(line)) continue;
    if (!/^£\s?[0-9]{1,6}(?:,[0-9]{3})*(?:\.\d{2})?$/.test(line)) continue;
    const value = parseMoney(line);
    if (value !== null && value >= minimum) return { value, text: line };
  }
  return null;
}

export function labelledValue(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:\\n]\\s*([^\\n]{1,160})`, "i"),
    new RegExp(`(?:${escaped})\\s*[:#-]\\s*([^\\n]{1,160})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function findIdentifier(text, labels, pattern = /[A-Z0-9][A-Z0-9._/-]{3,50}/i) {
  const value = labelledValue(text, labels);
  if (!value) return null;
  return value.match(pattern)?.[0] ?? null;
}

export function identityMatches(expected, actualValues, searchableText = "") {
  if (!expected) return null;
  const needle = normalizeIdentifier(expected);
  const values = [...actualValues.filter(Boolean), searchableText].map(normalizeIdentifier);
  return values.some((value) => value.includes(needle));
}

export function deriveInStock(availability, bodyText) {
  const value = `${availability ?? ""}\n${bodyText}`;
  if (/OutOfStock|out of stock|currently unavailable|sold out/i.test(value)) return false;
  if (/InStock|add to basket|available for delivery|available to order/i.test(value)) return true;
  return null;
}

export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || null;
}
