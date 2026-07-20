/**
 * ADR-020 D4 — confidence promotion tier (pure, DB-free, unit-tested).
 *
 * A cognitive memory graduates to the DURABLE tier once it is both highly
 * confident AND corroborated (cited/reinforced enough times). Durable records
 * are decay-exempt (the promoter sets half_life_days = null) and recalled first,
 * so proven knowledge stops aging out while unproven records still decay.
 */

/** Default promotion threshold: confidence at/above this is "high confidence". */
export const DEFAULT_PROMOTION_CONFIDENCE = 0.95;
/** Default corroboration floor: this many citations/reinforcements before promotion. */
export const DEFAULT_PROMOTION_MIN_CORROBORATIONS = 2;

export interface PromotionThresholds {
  confidence: number;
  minCorroborations: number;
}

export function promotionThresholds(overrides?: Partial<PromotionThresholds>): PromotionThresholds {
  const c = overrides?.confidence;
  const m = overrides?.minCorroborations;
  const confidence = typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : DEFAULT_PROMOTION_CONFIDENCE;
  const minCorroborations = typeof m === "number" && Number.isFinite(m) ? Math.max(1, Math.floor(m)) : DEFAULT_PROMOTION_MIN_CORROBORATIONS;
  return { confidence, minCorroborations };
}

/** Eligible for promotion iff high-confidence AND enough corroboration (and not already durable/archived). */
export function shouldPromoteToDurable(
  record: { confidence: number; citationCount: number; durable?: boolean; archived?: boolean },
  thresholds: PromotionThresholds = promotionThresholds(),
): boolean {
  if (record.durable || record.archived) return false;
  return record.confidence >= thresholds.confidence && record.citationCount >= thresholds.minCorroborations;
}
