import type { IdentifierEvidence, PriceCandidate } from "./types.js";
import { normalizeIdentifier } from "./security.js";

interface StructuredProductData {
  priceCandidates: PriceCandidate[];
  identifiers: IdentifierEvidence;
  availability: string | null;
}

function emptyIdentifiers(): IdentifierEvidence {
  return { sku: [], ean: [], mpn: [] };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(asRecords);
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

function productRecords(value: unknown): Record<string, unknown>[] {
  const records = asRecords(value);
  const expanded: Record<string, unknown>[] = [];
  for (const record of records) {
    expanded.push(record);
    if (record["@graph"]) expanded.push(...productRecords(record["@graph"]));
  }
  return expanded.filter((record) => {
    const type = record["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
}

function collectOfferPrices(offers: unknown): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  for (const offer of asRecords(offers)) {
    for (const key of ["price", "lowPrice"]) {
      const parsed = parsePrice(offer[key]);
      if (parsed !== null) {
        candidates.push({
          value: parsed,
          text: String(offer[key]),
          source: `jsonld.offer.${key}`,
          confidence: key === "price" ? 100 : 92,
        });
      }
    }
  }
  return candidates;
}

export function extractStructuredData(jsonLdTexts: string[]): StructuredProductData {
  const identifiers = emptyIdentifiers();
  const priceCandidates: PriceCandidate[] = [];
  let availability: string | null = null;

  for (const text of jsonLdTexts) {
    try {
      const parsed: unknown = JSON.parse(text);
      for (const product of productRecords(parsed)) {
        for (const key of ["sku", "productID"]) {
          if (typeof product[key] === "string") identifiers.sku.push(product[key]);
        }
        for (const key of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"]) {
          if (typeof product[key] === "string") identifiers.ean.push(product[key]);
        }
        if (typeof product.mpn === "string") identifiers.mpn.push(product.mpn);
        priceCandidates.push(...collectOfferPrices(product.offers));

        for (const offer of asRecords(product.offers)) {
          if (!availability && typeof offer.availability === "string") {
            availability = offer.availability.split("/").at(-1) ?? offer.availability;
          }
        }
      }
    } catch {
      // Retailer JSON-LD is occasionally malformed; other extraction paths remain available.
    }
  }

  identifiers.sku = unique(identifiers.sku);
  identifiers.ean = unique(identifiers.ean);
  identifiers.mpn = unique(identifiers.mpn);
  return { priceCandidates, identifiers, availability };
}

export function extractBodyIdentifiers(bodyText: string): IdentifierEvidence {
  const identifiers = emptyIdentifiers();
  const patterns: Array<[keyof IdentifierEvidence, RegExp]> = [
    ["sku", /(?:SKU|product\s*code|item\s*code|model(?:\s*number)?)[\s:#-]*([A-Z0-9][A-Z0-9._\/-]{3,40})/gi],
    ["ean", /(?:EAN|GTIN|barcode)[\s:#-]*(\d{8,14})/gi],
    ["mpn", /(?:MPN|manufacturer(?:'s)?\s*part(?:\s*number)?)[\s:#-]*([A-Z0-9][A-Z0-9._\/-]{3,40})/gi],
  ];

  for (const [kind, pattern] of patterns) {
    for (const match of bodyText.matchAll(pattern)) {
      const value = match[1];
      if (value) identifiers[kind].push(value);
    }
  }

  identifiers.sku = unique(identifiers.sku);
  identifiers.ean = unique(identifiers.ean);
  identifiers.mpn = unique(identifiers.mpn);
  return identifiers;
}

export function mergeIdentifiers(...sets: IdentifierEvidence[]): IdentifierEvidence {
  return {
    sku: unique(sets.flatMap((set) => set.sku)),
    ean: unique(sets.flatMap((set) => set.ean)),
    mpn: unique(sets.flatMap((set) => set.mpn)),
  };
}

export function identifierMatches(
  expectedSku: string | undefined,
  expectedEan: string | undefined,
  identifiers: IdentifierEvidence,
  searchableText: string,
): boolean | null {
  if (!expectedSku && !expectedEan) return null;
  const haystack = normalizeIdentifier(
    [searchableText, ...identifiers.sku, ...identifiers.ean, ...identifiers.mpn].join(" "),
  );
  const skuMatches = expectedSku ? haystack.includes(normalizeIdentifier(expectedSku)) : true;
  const eanMatches = expectedEan ? haystack.includes(normalizeIdentifier(expectedEan)) : true;
  return skuMatches && eanMatches;
}

export function parseVisiblePrices(texts: string[]): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/£\s?([0-9]{1,5}(?:,[0-9]{3})*(?:\.\d{2})?)/g)) {
      const value = parsePrice(match[1]);
      if (value !== null) {
        candidates.push({ value, text: match[0], source: "visible.price-element", confidence: 65 });
      }
    }
  }
  return candidates;
}

export function choosePrice(candidates: PriceCandidate[]): PriceCandidate | null {
  const plausible = candidates.filter((candidate) => candidate.value >= 20 && candidate.value <= 25000);
  plausible.sort((a, b) => b.confidence - a.confidence || a.value - b.value);
  return plausible[0] ?? null;
}
