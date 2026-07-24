import { readFile } from "node:fs/promises";
import { configFromEnvironment, runFromConfig } from "./cli.mjs";

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

function issueBodyToEnvironment(body) {
  const input = JSON.parse(body);
  const env = {
    MODE: input.mode,
    RETAILER: input.retailer ?? "currys",
    PRODUCT_URL: input.productUrl,
    CATALOGUE_URL: input.catalogueUrl,
    START_PAGE: input.startPage,
    END_PAGE: input.endPage,
    PAGE_SIZE: input.pageSize,
    EXPECTED_ITEM_NUMBER: input.expectedItemNumber,
    EXPECTED_MPN: input.expectedMpn,
    EXPECTED_EAN: input.expectedEan,
    EXPECTED_PRICE: input.expectedPrice,
    REPEAT_COUNT: input.repeatCount,
    REQUEST_DELAY_MS: input.requestDelayMs,
    HEADED: input.headed ?? true,
    SAVE_DEBUG: input.saveDebug ?? false,
    RESULTS_DIR: process.env.RESULTS_DIR ?? "results",
  };
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined || value === null ? "" : String(value)]),
  );
}

function catalogueSummary(result) {
  if (!result.pages) return [];
  const productResults = result.pages.flatMap((page) => page.productResults ?? []);
  const counts = productResults.reduce(
    (current, product) => ({ ...current, [product.status]: (current[product.status] ?? 0) + 1 }),
    {},
  );
  return [
    `**Mode:** \`${result.mode}\``,
    `**Catalogue pages completed:** ${result.pages.length}`,
    `**Products discovered:** ${result.pages.reduce((sum, page) => sum + (page.productUrls?.length ?? 0), 0)}`,
    `**Products verified:** ${result.pages.reduce((sum, page) => sum + (page.completedProductCount ?? 0), 0)}`,
    `**Product statuses:** \`${JSON.stringify(counts)}\``,
    `**Compact checkpoint evidence:**\n\n\`\`\`json\n${JSON.stringify(result.pages, null, 2).slice(0, 50000)}\n\`\`\``,
  ];
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const issue = event.issue;
  const owner = event.repository.owner.login;
  if (issue.user.login !== owner) throw new Error("Only an issue opened by the repository owner may run browser fetching");
  if (!issue.title.startsWith("[browser-fetch]")) throw new Error("Issue title must begin with [browser-fetch]");
  if (!issue.body) throw new Error("Issue body must contain a JSON request");

  let result;
  let error = null;
  try {
    result = await runFromConfig(configFromEnvironment({ ...process.env, ...issueBodyToEnvironment(issue.body) }));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const lines = result
    ? [
        `**Browser fetch status:** \`${result.status}\``,
        result.retailerItemNumber ? `**Currys item:** \`${result.retailerItemNumber}\`` : null,
        result.productTitle ? `**Product:** ${result.productTitle}` : null,
        result.mainPurchasePrice !== undefined
          ? `**Main price:** ${result.mainPurchasePrice === null ? "unknown" : `£${result.mainPurchasePrice.toFixed(2)}`}`
          : null,
        result.structuredOfferPrice !== undefined
          ? `**Structured price:** ${result.structuredOfferPrice === null ? "not available" : `£${result.structuredOfferPrice.toFixed(2)}`}`
          : null,
        result.manufacturerSku ? `**MPN:** \`${result.manufacturerSku}\`` : null,
        result.ean ? `**EAN:** \`${result.ean}\`` : null,
        result.cpu ? `**CPU:** ${result.cpu}` : null,
        result.ram ? `**RAM:** ${result.ram}` : null,
        result.storage ? `**Storage:** ${result.storage}` : null,
        result.display ? `**Display:** ${result.display}` : null,
        result.colour ? `**Colour:** ${result.colour}` : null,
        result.identityChecks?.identityBasis?.length
          ? `**Identity basis:** ${result.identityChecks.identityBasis.map((value) => `\`${value}\``).join(", ")}`
          : null,
        result.identityChecks?.expectedMpn && !result.identityChecks.mpnPublished
          ? `**MPN:** not published on this retailer page; expected value retained as external identity evidence`
          : null,
        result.identityChecks?.expectedEan && !result.identityChecks.eanPublished
          ? `**EAN:** not published on this retailer page; expected value retained as external identity evidence`
          : null,
        ...catalogueSummary(result),
        `**Eligible for controlled import:** ${result.eligible ? "yes" : "no"}`,
        result.conflicts?.length
          ? `**Conflicts:**\n${result.conflicts.map((value) => `- ${value}`).join("\n")}`
          : null,
        "The complete compact JSON evidence is attached to the workflow run artifact.",
      ].filter(Boolean)
    : ["**Browser fetch failed before producing evidence.**", `- ${error}`];

  const base = `https://api.github.com/repos/${event.repository.full_name}/issues/${issue.number}`;
  await githubRequest(`${base}/comments`, { method: "POST", body: JSON.stringify({ body: lines.join("\n\n") }) });
  await githubRequest(base, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  if (error || result.status !== "success") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
