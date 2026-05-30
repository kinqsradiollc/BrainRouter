/**
 * AUG-A3 (0.4.1) — modular ranking.
 *
 * The recall pipeline's score-composition math, pulled out of `recall.ts`
 * into one cohesive, unit-testable module. Three facets:
 *
 *   weighting  — scale + blend the RRF and priority signals
 *   boosting   — citation / freshness / skill / intent lifts
 *   penalties  — time decay
 *
 * Pure functions only (no I/O, no Date/config lookups — callers pass in the
 * already-resolved inputs). This is a faithful extraction: the numbers are
 * identical to the previous inline implementation. Distinct from
 * `../store/reranker.ts`, which is the semantic-reranking API client.
 */

export * from "./weighting.js";
export * from "./boosting.js";
export * from "./penalties.js";
export * from "./lexical.js";

import { halfLifeDecay } from "./penalties.js";
import { citationBoost, freshnessBoost } from "./boosting.js";

/**
 * Effective priority of a memory at recall time: its stored priority,
 * decayed by age, then lifted by citations and freshness.
 *
 *   priority · decay(age) · (1 + citationBoost) · freshness(age)
 *
 * Pure: callers resolve `halfLifeDays` (from the type config) and `ageDays`
 * (from `created_time`) and pass them in.
 */
export function effectivePriorityScore(params: {
  priority: number;
  ageDays: number;
  halfLifeDays?: number | null;
  citationCount?: number | null;
}): number {
  const base = params.priority * halfLifeDecay(params.ageDays, params.halfLifeDays);
  return base * (1 + citationBoost(params.citationCount)) * freshnessBoost(params.ageDays);
}
