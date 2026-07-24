import { identityFingerprint } from "./currys.mjs";
import { sameUrlIdentity } from "./security.mjs";

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

export function aggregateAttempts(attempts, expected = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) throw new Error("At least one browser attempt is required");
  const conflicts = attempts.flatMap((attempt, index) => attempt.conflicts.map((value) => `attempt ${index + 1}: ${value}`));
  const statuses = unique(attempts.map((attempt) => attempt.status));
  const prices = unique(attempts.map((attempt) => attempt.mainPurchasePrice));
  const structuredPrices = unique(attempts.map((attempt) => attempt.structuredOfferPrice));
  const itemNumbers = unique(attempts.map((attempt) => attempt.retailerItemNumber));
  const fingerprints = unique(attempts.map(identityFingerprint));
  const canonicalUrls = unique(attempts.map((attempt) => attempt.canonicalUrl));

  if (prices.length > 1) conflicts.push(`isolated browser loads returned multiple main prices: ${prices.join(", ")}`);
  if (structuredPrices.length > 1) conflicts.push(`isolated browser loads returned multiple structured prices: ${structuredPrices.join(", ")}`);
  if (itemNumbers.length > 1) conflicts.push(`isolated browser loads resolved to multiple retailer item numbers: ${itemNumbers.join(", ")}`);
  if (fingerprints.length > 1) conflicts.push("isolated browser loads returned materially different product identities");
  if (canonicalUrls.length > 1 && !canonicalUrls.every((url) => sameUrlIdentity(canonicalUrls[0], url))) {
    conflicts.push("isolated browser loads resolved to different canonical product URLs");
  }

  let status = "success";
  if (statuses.includes("blocked")) status = "blocked";
  else if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("conflict") || conflicts.length) status = "conflict";

  const representative = attempts.find((attempt) => attempt.status === "success") ?? attempts[0];
  const eligible = status === "success"
    && Boolean(representative.retailerItemNumber)
    && Boolean(representative.identityChecks?.strongIdentity ?? (representative.manufacturerSku || representative.ean))
    && representative.mainPurchasePrice !== null
    && (representative.structuredOfferPrice === null
      || Math.abs(representative.mainPurchasePrice - representative.structuredOfferPrice) < 0.009);

  return {
    schemaVersion: 1,
    status,
    eligible,
    retailer: "currys",
    requestedUrl: representative.requestedUrl,
    finalUrl: representative.finalUrl,
    canonicalUrl: representative.canonicalUrl,
    httpStatus: representative.httpStatus,
    retailerItemNumber: representative.retailerItemNumber,
    productTitle: representative.productTitle,
    manufacturer: representative.manufacturer,
    modelFamily: representative.modelFamily,
    manufacturerSku: representative.manufacturerSku,
    ean: representative.ean,
    cpu: representative.cpu,
    gpu: representative.gpu,
    ram: representative.ram,
    storage: representative.storage,
    display: representative.display,
    colour: representative.colour,
    mainPurchasePrice: representative.mainPurchasePrice,
    deliveryCharge: representative.deliveryCharge,
    effectivePrice: representative.effectivePrice,
    currency: representative.currency,
    availability: representative.availability,
    inStock: representative.inStock,
    structuredOfferPrice: representative.structuredOfferPrice,
    timestamp: new Date().toISOString(),
    verificationMethod: `${attempts.length} isolated ${representative.verificationMethod} loads`,
    conflicts: unique(conflicts),
    evidenceUrls: unique(attempts.flatMap((attempt) => attempt.evidenceUrls)),
    provenance: representative.provenance,
    identityChecks: representative.identityChecks,
    expected: {
      itemNumber: expected.itemNumber ?? null,
      mpn: expected.mpn ?? null,
      ean: expected.ean ?? null,
      price: expected.price ?? null,
    },
    attempts: attempts.map(({ _debug, ...attempt }) => attempt),
  };
}
