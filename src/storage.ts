import type { PriceObservation } from "./types.js";

function observationRow(observation: PriceObservation): Record<string, unknown> {
  return {
    run_id: observation.runId,
    target_id: observation.targetId,
    retailer: observation.retailer,
    requested_url: observation.requestedUrl,
    final_url: observation.finalUrl,
    observed_at: observation.observedAt,
    status: observation.status,
    accepted: observation.accepted,
    http_status: observation.httpStatus,
    page_title: observation.title,
    currency: observation.currency,
    price: observation.price,
    price_text: observation.priceText,
    availability: observation.availability,
    expected_sku: observation.expectedSku,
    expected_ean: observation.expectedEan,
    identifier_match: observation.identifierMatch,
    identifiers: observation.identifiers,
    price_candidates: observation.priceCandidates,
    screenshot_file: observation.screenshotFile,
    duration_ms: observation.durationMs,
    error: observation.error,
  };
}

export async function saveToSupabase(observation: PriceObservation): Promise<boolean> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = process.env.SUPABASE_TABLE?.trim() || "browser_price_observations";
  if (!supabaseUrl || !key) return false;

  const response = await fetch(`${supabaseUrl}/rest/v1/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(observationRow(observation)),
  });

  if (!response.ok) {
    throw new Error(`Supabase insert failed (${response.status}): ${await response.text()}`);
  }
  return true;
}
