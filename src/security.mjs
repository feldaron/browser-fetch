import { isIP } from "node:net";

const RETAILER_HOSTS = Object.freeze({
  currys: ["currys.co.uk", "www.currys.co.uk", "business.currys.co.uk"],
  argos: ["argos.co.uk", "www.argos.co.uk"],
});

export function allowedHosts(retailer) {
  const hosts = RETAILER_HOSTS[String(retailer).toLowerCase()];
  if (!hosts) throw new Error(`Unsupported retailer: ${retailer}`);
  return hosts;
}

export function validateRetailerUrl(rawUrl, retailer = "currys") {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Only HTTPS retailer URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  if (isIP(url.hostname)) throw new Error("IP-address targets are not allowed");
  if (!allowedHosts(retailer).includes(url.hostname.toLowerCase())) {
    throw new Error(`URL host is not allowed for ${retailer}: ${url.hostname}`);
  }
  url.hash = "";
  return url;
}

export function normalizeIdentifier(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function sameUrlIdentity(left, right) {
  if (!left || !right) return false;
  const a = new URL(left);
  const b = new URL(right);
  return a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.pathname === b.pathname;
}
