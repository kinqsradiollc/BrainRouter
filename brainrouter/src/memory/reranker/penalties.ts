/**
 * AUG-A3 (0.4.1) — modular ranking: penalties.
 *
 * Score-reducing factors. Currently just time decay: a memory's stored
 * priority is attenuated by an exponential half-life. Extracted verbatim
 * from the inline `effectivePriority` in `recall.ts` — no behaviour change.
 *
 * (Distinct from `store/reranker.ts`, which is the Cohere/vLLM semantic
 * reranking API client. This module is the pure score-composition math.)
 */

/** Half-life decay base: priority halves every `halfLifeDays`. */
export const DECAY_BASE = 0.5;

/**
 * Exponential half-life decay multiplier in (0, 1].
 *
 * `pow(0.5, ageDays / halfLifeDays)` — 1.0 at age 0, 0.5 at one half-life.
 * A falsy `halfLifeDays` (0, null, undefined) means "never decays" → 1.0,
 * mirroring the original `if (halfLife) { … }` guard.
 */
export function halfLifeDecay(ageDays: number, halfLifeDays: number | null | undefined): number {
  if (!halfLifeDays) return 1;
  return Math.pow(DECAY_BASE, ageDays / halfLifeDays);
}

/** B7 (MEM-CHURN) — commits-in-90d that roughly HALVE a memory's half-life. */
export const CHURN_HALF_LIFE_SCALE = 20;

/**
 * B7 (MEM-CHURN, 0.4.11) — shorten a code-anchored memory's half-life when its
 * source file is high-churn (many recent commits), so memories on volatile code
 * decay faster than ones on stable code. Pure + null-safe:
 *   - a falsy base half-life ("never decays") is returned unchanged;
 *   - `null`/`0`/negative churn returns the base unchanged — so memories with NO
 *     captured churn (all existing data, every non-code memory) are UNAFFECTED.
 * Otherwise `base / (1 + commits / SCALE)`, floored at 1 day so a hot file's
 * memories still survive briefly.
 */
export function churnAdjustedHalfLife(
  baseHalfLifeDays: number | null | undefined,
  commitCount90d: number | null | undefined,
): number | null | undefined {
  if (!baseHalfLifeDays) return baseHalfLifeDays;
  const churn = commitCount90d ?? 0;
  if (churn <= 0) return baseHalfLifeDays;
  return Math.max(1, baseHalfLifeDays / (1 + churn / CHURN_HALF_LIFE_SCALE));
}
