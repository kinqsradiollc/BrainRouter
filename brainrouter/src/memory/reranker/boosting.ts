/**
 * AUG-A3 (0.4.1) — modular ranking: boosts.
 *
 * Score-increasing multipliers/lifts. Each is a pure function of one input
 * so the constants live in exactly one place and unit-test cleanly.
 * Extracted verbatim from `recall.ts` — no behaviour change.
 */

/** Per-citation lift and its cap (a memory cited a lot gets at most +30%). */
export const CITATION_BOOST_PER = 0.05;
export const CITATION_BOOST_CAP = 0.3;

/** Citation boost as an additive fraction in [0, CITATION_BOOST_CAP]. */
export function citationBoost(citationCount: number | null | undefined): number {
  return Math.min((citationCount ?? 0) * CITATION_BOOST_PER, CITATION_BOOST_CAP);
}

/** Max freshness lift (applied at age 0, ramping to 0 at age 1d). */
export const FRESHNESS_MAX_LIFT = 0.15;

/**
 * Freshness multiplier: anything captured in the last 24h gets a small lift
 * so brand-new facts surface even before they've been cited. Linear ramp
 * from 1.15× at age 0 to 1.0× at age 1d; 1.0× beyond.
 */
export function freshnessBoost(ageDays: number): number {
  return ageDays <= 1 ? 1 + FRESHNESS_MAX_LIFT * (1 - ageDays) : 1;
}

/** Multiplier applied when a record's skill_tag matches the active skill. */
export const SKILL_BOOST = 1.2;

/** `SKILL_BOOST` when the active skill matches, else 1 (no-op). */
export function skillBoost(matchesActiveSkill: boolean): number {
  return matchesActiveSkill ? SKILL_BOOST : 1;
}

/**
 * Intent-affinity multiplier from a memory type's config. A missing affinity
 * (undefined) is a no-op (1), matching the original `?? 1`.
 */
export function intentBoost(intentAffinity: number | null | undefined): number {
  return intentAffinity ?? 1;
}
