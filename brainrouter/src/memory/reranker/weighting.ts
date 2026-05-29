/**
 * AUG-A3 (0.4.1) — modular ranking: weighting.
 *
 * How the retrieval (RRF) score and the decayed priority score are scaled
 * and blended into a single rerank score. Extracted verbatim from the
 * scoring loop in `recall.ts` — no behaviour change.
 */

/** RRF scores are tiny (≈1/61); scale them into a comparable range. */
export const RRF_SCORE_SCALE = 30;

/** Stored priorities are 0–100; normalize to 0–1 before blending. */
export const PRIORITY_SCALE = 100;

/** Blend weights — retrieval relevance dominates, priority adjusts. */
export const BASE_WEIGHT = 0.7;
export const PRIORITY_WEIGHT = 0.3;

/** Scale a raw RRF score into the base relevance score. */
export function baseScoreFromRrf(rrfScore: number): number {
  return rrfScore * RRF_SCORE_SCALE;
}

/** Normalize an effective-priority value (0–100 range) to ~0–1. */
export function normalizePriority(effectivePriority: number): number {
  return effectivePriority / PRIORITY_SCALE;
}

/** Weighted blend of base relevance and normalized priority. */
export function blendBaseAndPriority(baseScore: number, priorityScore: number): number {
  return baseScore * BASE_WEIGHT + priorityScore * PRIORITY_WEIGHT;
}
