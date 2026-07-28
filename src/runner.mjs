import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { aggregateAttempts } from "./aggregate.mjs";
import { launchChrome, loadRetailerAttempt } from "./browser.mjs";

function safeName(value) {
  return String(value ?? "result").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "result";
}

async function writeDebugFiles(attempts, result, outputDirectory) {
  if (result.status === "success") return;
  const debugDirectory = path.join(outputDirectory, "debug");
  await mkdir(debugDirectory, { recursive: true });
  for (const [index, attempt] of attempts.entries()) {
    const debug = attempt._debug;
    if (!debug) continue;
    const base = `${safeName(result.retailerItemNumber ?? "unknown")}-attempt-${index + 1}`;
    if (debug.html) await writeFile(path.join(debugDirectory, `${base}.html`), debug.html, "utf8");
    if (debug.screenshot) await writeFile(path.join(debugDirectory, `${base}.png`), debug.screenshot);
  }
}

export async function verifyProduct(target, options = {}) {
  const repeatCount = Number(options.repeatCount ?? 3);
  if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 8) throw new Error("repeatCount must be an integer from 1 to 8");
  const outputDirectory = options.outputDirectory ?? "results";
  await mkdir(outputDirectory, { recursive: true });
  const browser = await launchChrome({ headed: options.headed !== false });
  const attempts = [];

  try {
    for (let index = 0; index < repeatCount; index += 1) {
      const attempt = await loadRetailerAttempt(browser, target, { captureDebug: Boolean(options.captureDebug), retailer: options.retailer ?? "currys" });
      attempts.push(attempt);
      if (attempt.status === "blocked") break;
      if (index + 1 < repeatCount) await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs ?? 1200)));
    }

    let result = aggregateAttempts(attempts, target.expected);
    if (result.status !== "success" && !options.captureDebug && attempts.every((attempt) => !attempt._debug)) {
      const diagnostic = await loadRetailerAttempt(browser, target, { captureDebug: true, retailer: options.retailer ?? "currys" });
      attempts.push(diagnostic);
      result = aggregateAttempts(attempts, target.expected);
    }
    await writeDebugFiles(attempts, result, outputDirectory);
    const compact = {
      ...result,
      attempts: result.attempts.map(({ _debug, ...attempt }) => attempt),
    };
    const item = compact.retailerItemNumber ?? safeName(target.url);
    await writeFile(path.join(outputDirectory, `product-${item}.json`), `${JSON.stringify(compact, null, 2)}\n`, "utf8");
    return compact;
  } finally {
    await browser.close();
  }
}
