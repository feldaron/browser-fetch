import { isIP } from "node:net";

const BUILT_IN_ALLOWED_HOSTS = [
  "currys.co.uk",
  "johnlewis.com",
  "argos.co.uk",
  "very.co.uk",
  "ao.com",
  "amazon.co.uk",
  "costco.co.uk",
  "lenovo.com",
  "hp.com",
  "dell.com",
  "asus.com",
  "acer.com",
  "samsung.com",
  "lg.com",
  "huawei.com",
  "gigabyte.com",
];

export function allowedHosts(): string[] {
  const extras = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_ALLOWED_HOSTS, ...extras])];
}

export function isAllowedHostname(hostname: string, allowlist = allowedHosts()): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || isIP(host) !== 0) return false;
  return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function validateTargetUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (!isAllowedHostname(url.hostname)) {
    throw new Error(`Host is not on the retailer allowlist: ${url.hostname}`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function normalizeIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
