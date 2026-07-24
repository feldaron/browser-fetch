import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchBrowser, fetchWithBrowser } from "./browser.js";
import { readIssueTarget, reportIssueResult } from "./github-issue.js";
import { saveToSupabase } from "./storage.js";
import { targetSchema, targetsSchema, type FetchTarget, type PriceObservation } from "./types.js";

const outputDirectory = process.env.OUTPUT_DIRECTORY ?? "results";

async function persist(observation: PriceObservation): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const filename = path.join(outputDirectory, `${observation.runId}.json`);
  await writeFile(filename, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  const stored = await saveToSupabase(observation);
  console.log(JSON.stringify({ ...observation, storedInSupabase: stored }, null, 2));
}

async function runTarget(target: FetchTarget): Promise<PriceObservation> {
  const browser = await launchBrowser();
  try {
    const observation = await fetchWithBrowser(browser, target, outputDirectory);
    await persist(observation);
    return observation;
  } finally {
    await browser.close();
  }
}

async function single(): Promise<void> {
  const target = targetSchema.parse({
    id: process.env.TARGET_ID || undefined,
    retailer: process.env.RETAILER || undefined,
    url: process.env.TARGET_URL,
    expectedSku: process.env.EXPECTED_SKU || undefined,
    expectedEan: process.env.EXPECTED_EAN || undefined,
  });
  await runTarget(target);
}

async function batch(): Promise<void> {
  const targetFile = process.env.TARGETS_FILE ?? "config/targets.json";
  const allTargets = targetsSchema.parse(JSON.parse(await readFile(targetFile, "utf8")));
  const shardIndex = Number.parseInt(process.env.SHARD_INDEX ?? "0", 10);
  const shardTotal = Number.parseInt(process.env.SHARD_TOTAL ?? "1", 10);
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1 || shardIndex < 0 || shardIndex >= shardTotal) {
    throw new Error("Invalid SHARD_INDEX/SHARD_TOTAL");
  }
  const targets = allTargets.filter((_, index) => index % shardTotal === shardIndex);
  console.log(`Shard ${shardIndex + 1}/${shardTotal}: ${targets.length} of ${allTargets.length} targets`);
  if (targets.length === 0) return;

  const browser = await launchBrowser();
  try {
    for (const target of targets) {
      const observation = await fetchWithBrowser(browser, target, outputDirectory);
      await persist(observation);
      const delay = Number.parseInt(process.env.REQUEST_DELAY_MS ?? "1500", 10);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally {
    await browser.close();
  }
}

async function issue(): Promise<void> {
  const { event, target } = await readIssueTarget();
  try {
    const observation = await runTarget(target);
    await reportIssueResult(event, observation, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportIssueResult(event, null, message);
    throw error;
  }
}

const mode = process.argv[2];
const commands: Record<string, () => Promise<void>> = { single, batch, issue };
const command = mode ? commands[mode] : undefined;
if (!command) throw new Error("Usage: tsx src/cli.ts <single|batch|issue>");
await command();
