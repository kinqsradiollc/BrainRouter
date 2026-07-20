/**
 * ADR-020 D1 — skill reliability lifecycle (pure, DB-free, unit-tested).
 *
 * A registered skill accrues a runtime reputation: each time its hints inform a
 * turn it is scored by that turn's outcome. `successRate` ranks reliable skills
 * above flaky ones; once a skill has enough evidence AND a low enough rate it is
 * DEMOTED (hidden from default injection, kept for audit — recoverable). A
 * reliability factor folds the rate into recall ranking so proven skills float
 * up and unproven ones stay neutral until they earn (or lose) trust.
 */

/** Below this success rate, with at least MIN_USES_FOR_DEMOTION uses, a skill is demoted. */
export const SKILL_DEMOTION_FLOOR = 0.4;
/** A skill needs this many recorded uses before it can be demoted (avoid punishing a single early failure). */
export const MIN_USES_FOR_DEMOTION = 5;

export interface SkillReliabilityCounters {
  usageCount: number;
  successCount: number;
}

/** Success rate in [0,1]; an unused skill is treated as neutral (1 — innocent until proven flaky). */
export function skillSuccessRate({ usageCount, successCount }: SkillReliabilityCounters): number {
  if (usageCount <= 0) return 1;
  return Math.max(0, Math.min(1, successCount / usageCount));
}

/** A skill is demoted once it has real evidence (>= MIN_USES) and a rate below the floor. */
export function shouldDemoteSkill(counters: SkillReliabilityCounters, floor = SKILL_DEMOTION_FLOOR): boolean {
  if (counters.usageCount < MIN_USES_FOR_DEMOTION) return false;
  return skillSuccessRate(counters) < floor;
}

/**
 * Recall-ranking multiplier for a skill. Unproven skills (few uses) stay ~1 so
 * they are neither privileged nor buried; as evidence accrues the factor tracks
 * the success rate, bounded to [0.5, 1.25] so a great skill gets a modest boost
 * and a poor one a modest penalty without ever dominating the reranker.
 */
export function skillReliabilityFactor(counters: SkillReliabilityCounters): number {
  const rate = skillSuccessRate(counters);
  // Confidence in the rate grows with evidence; blend from neutral (1) toward the
  // rate-target (0→0.5, 1→1.25) as uses accrue, so thin evidence stays ~neutral.
  const evidence = Math.min(1, counters.usageCount / MIN_USES_FOR_DEMOTION);
  const target = 0.5 + rate * 0.75;
  const factor = 1 * (1 - evidence) + target * evidence;
  return Math.max(0.5, Math.min(1.25, factor));
}
