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
