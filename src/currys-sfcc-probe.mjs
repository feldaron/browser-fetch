import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "https://www.currys.co.uk/on/demandware.store/Sites-curryspcworlduk-Site/en_GB";
const BLOCK = /captcha|access denied|verify (?:that )?you are human|unusual traffic|robot check|temporarily blocked|sorry,? you have been blocked|you have been blocked/i;
const ENDPOINTS = Object.freeze([
  { name: "Product-ShowQuickView", url: (pid) => `${BASE}/Product-ShowQuickView?pid=${pid}` },
  { name: "Product-Variation", url: (pid) => `${BASE}/Product-Variation?pid=${pid}&quantity=1` },
  { name: "Product-Show", url: (pid) => `${BASE}/Product-Show?pid=${pid}` },
]);

function validateItem(value) {
  const item = String(value ?? "").trim();
  if (!/^\d{8}$/.test(item)) throw new Error("CURRYS_ITEM_NUMBER must be exactly eight digits");
  return item;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&pound;/gi, "£");
}

function textFromHtml(html) {
  return decodeHtml(String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function first(value, pattern) {
  const match = String(value ?? "").match(pattern);
  return match?.[1] ? decodeHtml(match[1].replace(/<[^>]+>/g, " ")).trim() : null;
}

function priceCandidates(text) {
  const values = [...String(text ?? "").matchAll(/£\s*([0-9]{1,5}(?:,[0-9]{3})*(?:\.\d{2})?)/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 20 && value <= 20000);
  return [...new Set(values)].slice(0, 30);
}

function availabilitySignals(text) {
  const patterns = [
    /https?:\/\/schema\.org\/(InStock|OutOfStock|SoldOut|LimitedAvailability|PreOrder|BackOrder|Discontinued)/gi,
    /\b(in stock|out of stock|sold out|available for delivery|unavailable|collect in store|order & collect)\b/gi,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...String(text ?? "").matchAll(pattern)].map((match) => match[0])))].slice(0, 30);
}

function selectedJsonFields(value, prefix = "", output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value) || output.length >= 100) return output;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/price|currency|availability|stock|inventory|ats|sku|product.?id|pid|ean|gtin|mpn/i.test(current)) {
      if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) output.push([current, entry]);
      else if (Array.isArray(entry) && entry.every((item) => ["string", "number", "boolean"].includes(typeof item))) output.push([current, entry]);
    }
    if (entry && typeof entry === "object") selectedJsonFields(entry, current, output, seen);
    if (output.length >= 100) break;
  }
  return output;
}

export async function probeEndpoint(endpoint, item, options = {}) {
  const url = endpoint.url(validateItem(item));
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      Accept: "application/json,text/html;q=0.9,application/xhtml+xml;q=0.8",
      "Accept-Language": "en-GB,en;q=0.8",
      "Cache-Control": "no-cache",
      "User-Agent": "LaptopValuePriceMonitor/1.0 (+https://www.laptopvalue.co.uk)",
    },
  });
  const body = await response.text();
  const contentType = response.headers?.get?.("content-type") ?? null;
  let json = null;
  let jsonError = null;
  if (/json/i.test(contentType ?? "") || /^[\s\r\n]*[\[{]/.test(body)) {
    try { json = JSON.parse(body); } catch (error) { jsonError = error instanceof Error ? error.message : String(error); }
  }
  const visibleText = json ? "" : textFromHtml(body);
  const title = json ? null : first(body, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const heading = json ? null : first(body, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const blocked = [403, 429].includes(response.status) || BLOCK.test([title, heading, body.slice(0, 12000)].filter(Boolean).join("\n"));
  const serialized = json ? JSON.stringify(json) : body;
  const containsItem = serialized.includes(item);
  const selectedFields = json ? selectedJsonFields(json) : [];
  const structuredPrices = selectedFields
    .filter(([field, value]) => /price/i.test(field) && (typeof value === "number" || typeof value === "string"))
    .map(([, value]) => Number(String(value).replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 20 && value <= 20000);
  const prices = json ? [...new Set(structuredPrices)].slice(0, 30) : priceCandidates(visibleText);
  const availability = availabilitySignals(serialized);
  const useful = response.status === 200 && !blocked && containsItem && prices.length > 0 && availability.length > 0;
  return {
    endpoint: endpoint.name,
    requestedUrl: url,
    finalUrl: response.url || url,
    httpStatus: response.status,
    contentType,
    responseBytes: Buffer.byteLength(body),
    responseKind: json ? "json" : "html",
    blocked,
    containsRequestedItem: containsItem,
    useful,
    title,
    heading,
    priceCandidates: prices,
    availabilitySignals: availability,
    selectedJsonFields: selectedFields,
    jsonParseError: jsonError,
    timestamp: new Date().toISOString(),
    _body: body,
  };
}

export async function runSfccProbe(item, options = {}) {
  const validated = validateItem(item);
  const outputDirectory = options.outputDirectory ?? "results/sfcc";
  await mkdir(outputDirectory, { recursive: true });
  const attempts = [];
  for (const endpoint of ENDPOINTS) {
    const result = await probeEndpoint(endpoint, validated, options);
    const { _body, ...compact } = result;
    attempts.push(compact);
    if (!result.blocked && result.httpStatus === 200) {
      const extension = result.responseKind === "json" ? "json" : "html";
      await writeFile(path.join(outputDirectory, `${endpoint.name}.${extension}`), result._body.slice(0, 1_000_000), "utf8");
    }
  }
  const useful = attempts.filter((attempt) => attempt.useful);
  return {
    schemaVersion: 1,
    status: useful.length ? "candidate" : attempts.every((attempt) => attempt.blocked) ? "blocked" : "failed",
    eligibleForSupabase: false,
    retailerItemNumber: validated,
    permissionBasis: "user confirmed permission for automated read-only access to /on/demandware.store/*",
    attempts,
    usefulEndpoints: useful.map((attempt) => attempt.endpoint),
    note: useful.length
      ? "Candidate transport found. Response semantics still require exact price and stock extraction plus repeated-agreement tests before database use."
      : "No endpoint returned item identity, a plausible price and an availability signal together.",
  };
}

async function main() {
  const result = await runSfccProbe(process.env.CURRYS_ITEM_NUMBER, {
    outputDirectory: process.env.RESULTS_DIR ?? "results/sfcc",
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "candidate" ? 0 : result.status === "blocked" ? 3 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 4;
  });
}
