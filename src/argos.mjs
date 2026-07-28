import {
  cleanText, deriveInStock, extractStandalonePrice, findIdentifier,
  labelledValue, parseJsonLdTexts,
} from "./extract.mjs";
import { normalizeIdentifier } from "./security.mjs";

const BLOCK = /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked/i;

export function argosItemNumber(url) {
  if (!url) return null;
  const path = new URL(url).pathname;
  return path.match(/\/product\/(\d{7})(?:\/|$)/)?.[1] ?? null;
}

function first(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text ?? "").match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return null;
}

export function extractArgosSpecs(title, body, structured = {}) {
  const text = `${title ?? ""}\n${body ?? ""}`;
  const cpu = labelledValue(body, ["Processor", "Processor model"])
    ?? first(title, [/\b((?:Intel\s+)?Core\s+(?:Ultra\s+)?[A-Z]?\d(?:\s+\d{3,4}[A-Z]*)?)\b/i, /\b(AMD\s+Ryzen\s+(?:AI\s+)?\d(?:\s+\d{3,4}[A-Z]*)?)\b/i, /\b(Snapdragon\s+X(?:2)?(?:\s+(?:Elite|Plus))?(?:\s+[A-Z0-9-]+)?)\b/i]);
  const ram = labelledValue(body, ["RAM size", "RAM"])
    ?? first(text, [/\b(\d{1,3}\s*GB)\s*(?:RAM|LPDDR|DDR)/i]);
  const storage = labelledValue(body, ["Storage capacity", "Hard drive capacity", "SSD storage"])
    ?? first(text, [/\b((?:\d+(?:\.\d+)?)\s*(?:TB|GB)\s*(?:SSD|storage))\b/i]);
  const mpn = structured.identifiers?.mpn
    ?? findIdentifier(body, ["Manufacturer's Part Number", "Manufacturer part number", "MPN", "Model number"]);
  const ean = structured.identifiers?.ean
    ?? findIdentifier(body, ["EAN", "GTIN", "Barcode"], /\d{8,14}/);
  const manufacturer = structured.manufacturer ?? first(title, [/^([A-Z][A-Z0-9]+)/i]);
  const modelFamily = cleanText((title || structured.productName || "").replace(/^([A-Z][A-Z0-9]+)\s+/i, "").split(/\s+-\s+|\s+\d+GB RAM/i)[0]);
  const storageEvidence = storage ? "published-storage" : null;
  const cpuEvidence = cpu ? "published-cpu" : null;
  const ramEvidence = ram ? "published-ram" : null;
  return {
    manufacturer, modelFamily, manufacturerSku: mpn, ean,
    retailerSku: structured.identifiers?.sku ?? null,
    cpu, gpu: labelledValue(body, ["Graphics", "Graphics card"]),
    ram, storage,
    display: labelledValue(body, ["Screen size", "Display size"]),
    colour: labelledValue(body, ["Colour"]),
    _identityEvidence: [cpuEvidence, ramEvidence, storageEvidence].filter(Boolean),
  };
}

export function evaluateArgosAttempt(raw, expected = {}) {
  const structured = parseJsonLdTexts(raw.jsonLdTexts ?? []);
  const title = cleanText(raw.heading) ?? cleanText(structured.productName) ?? cleanText(raw.documentTitle);
  const canonicalUrl = raw.canonicalUrl ?? raw.finalUrl;
  const requestedItem = argosItemNumber(raw.requestedUrl);
  const finalItem = argosItemNumber(raw.finalUrl);
  const canonicalItem = argosItemNumber(canonicalUrl);
  const itemNumber = canonicalItem ?? finalItem ?? requestedItem;
  const elementPrice = extractStandalonePrice((raw.priceElementTexts ?? []).flatMap((v) => String(v).split(/\r?\n/)));
  const mainPrice = elementPrice ?? (structured.structuredPrice !== null ? { value: structured.structuredPrice, text: String(structured.structuredPrice), method: "jsonld-cross-checked-visible-page" } : null);
  const extracted = extractArgosSpecs(title, raw.bodyText, structured);
  const { _identityEvidence: identityEvidence, ...specs } = extracted;
  const deliveryMatch = String(raw.mainText).match(/delivery(?:\s+from)?\s+£\s*([0-9]+(?:\.\d{2})?)/i);
  const deliveryCharge = /free delivery/i.test(raw.mainText) ? 0 : deliveryMatch ? Number(deliveryMatch[1]) : null;
  const conflicts = [];
  if (requestedItem && finalItem && requestedItem !== finalItem) conflicts.push(`redirect changed Argos catalogue number from ${requestedItem} to ${finalItem}`);
  if (expected.itemNumber && itemNumber !== String(expected.itemNumber)) conflicts.push(`expected Argos item ${expected.itemNumber}, found ${itemNumber ?? "unknown"}`);
  if (mainPrice && structured.structuredPrice !== null && Math.abs(mainPrice.value - structured.structuredPrice) > 0.02) conflicts.push("visible and structured prices disagree");
  const blocked = [403,429].includes(raw.httpStatus) || BLOCK.test([raw.documentTitle, raw.heading, raw.bodyText].filter(Boolean).join("\n"));
  if (blocked) conflicts.push("retailer block page detected; product evidence quarantined");
  const itemConfirmed = expected.itemNumber ? itemNumber === String(expected.itemNumber) : Boolean(itemNumber && requestedItem === itemNumber && (!canonicalItem || canonicalItem === itemNumber));
  const canonicalConfirmed = Boolean(canonicalItem && canonicalItem === itemNumber);
  const publishedIdentifier = Boolean(specs.manufacturerSku || specs.ean);
  const exactConfiguration = Boolean(specs.cpu && specs.ram && specs.storage);
  const strongIdentity = Boolean(!blocked && itemConfirmed && canonicalConfirmed && title && publishedIdentifier && exactConfiguration);
  let status = blocked ? "blocked" : conflicts.length ? "conflict" : (!mainPrice || !title || !itemNumber ? "failed" : "success");
  if (status === "success" && !strongIdentity) {
    status = "conflict";
    conflicts.push("identity is insufficient: require Argos catalogue number, canonical URL, MPN or EAN, exact CPU, RAM and storage");
  }
  return {
    status, requestedUrl: raw.requestedUrl, finalUrl: raw.finalUrl, canonicalUrl,
    httpStatus: raw.httpStatus, retailerItemNumber: itemNumber, productTitle: title, ...specs,
    mainPurchasePrice: mainPrice?.value ?? null, mainPurchasePriceText: mainPrice?.text ?? null,
    deliveryCharge, effectivePrice: mainPrice ? mainPrice.value + (deliveryCharge ?? 0) : null,
    currency: "GBP", availability: structured.availability,
    inStock: deriveInStock(structured.availability, raw.mainText), structuredOfferPrice: structured.structuredPrice,
    timestamp: raw.timestamp, verificationMethod: "headed Google Chrome / isolated Playwright context / Argos product page",
    identityChecks: { expectedItemNumber: expected.itemNumber ?? null, itemNumberMatch: expected.itemNumber ? itemNumber === String(expected.itemNumber) : null, strongIdentity, identityBasis: ["retailer-item-number","canonical-item-number", specs.manufacturerSku ? "manufacturer-sku" : null, specs.ean ? "ean" : null, ...identityEvidence].filter(Boolean) },
    conflicts, evidenceUrls: [...new Set([raw.requestedUrl, raw.finalUrl, canonicalUrl].filter(Boolean))],
    provenance: { mainPrice: mainPrice?.method ?? "not-found", priceBasis: "published-consumer-price", delivery: deliveryCharge === null ? "not-found" : "published-delivery-text", canonical: raw.canonicalUrl ? "link[rel=canonical]" : "final-url-fallback", specificationScope: "Argos published product identity and specifications" },
    _debug: raw._debug ?? null,
  };
}
