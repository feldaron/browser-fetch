import { z } from "zod";

export const targetSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  retailer: z.string().trim().min(1).max(120).optional(),
  url: z.string().url(),
  expectedSku: z.string().trim().min(1).max(160).optional(),
  expectedEan: z.string().trim().regex(/^\d{8,14}$/).optional(),
});

export const targetsSchema = z.array(targetSchema).max(2000);
export type FetchTarget = z.infer<typeof targetSchema>;

export type ObservationStatus =
  | "ok"
  | "identifier_mismatch"
  | "price_not_found"
  | "blocked"
  | "navigation_error"
  | "error";

export interface PriceCandidate {
  value: number;
  text: string;
  source: string;
  confidence: number;
}

export interface IdentifierEvidence {
  sku: string[];
  ean: string[];
  mpn: string[];
}

export interface PriceObservation {
  runId: string;
  targetId: string | null;
  retailer: string;
  requestedUrl: string;
  finalUrl: string | null;
  observedAt: string;
  status: ObservationStatus;
  accepted: boolean;
  httpStatus: number | null;
  title: string | null;
  currency: "GBP";
  price: number | null;
  priceText: string | null;
  availability: string | null;
  expectedSku: string | null;
  expectedEan: string | null;
  identifierMatch: boolean | null;
  identifiers: IdentifierEvidence;
  priceCandidates: PriceCandidate[];
  screenshotFile: string | null;
  durationMs: number;
  error: string | null;
}
