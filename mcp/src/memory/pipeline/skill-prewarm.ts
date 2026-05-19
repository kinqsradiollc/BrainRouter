/**
 * Skill Pre-warming Pipeline
 *
 * Analyses recent `skill_context` L1 memories to detect which skills the user
 * has been working with heavily. When a skill appears ≥ minHits times within
 * the last `windowN` L1 captures, its registered extraction hints are proactively
 * injected into `appendSystemContext` as a `<skill-prewarm>` block.
 *
 * This is opt-in via BRAINROUTER_PREWARM_ENABLED=true (disabled by default).
 */

import type { IMemoryStore } from "@brainrouter/types";

export interface PrewarmResult {
  skillName: string;
  hitCount: number;
  hints: string;
}

/**
 * Detect which skills qualify for pre-warming based on recent activity.
 * Returns an array of skill names and their hints, sorted by hit count (most active first).
 *
 * @param userId - The user to analyse
 * @param store - IMemoryStore instance
 * @param windowN - How many recent L1s to scan (default: BRAINROUTER_PREWARM_WINDOW or 10)
 * @param minHits - Min occurrences to qualify (default: BRAINROUTER_PREWARM_MIN_HITS or 3)
 * @param excludeSkill - Active skill to exclude (already injected via capture pipeline)
 */
export function detectPrewarmSkills(params: {
  userId: string;
  store: IMemoryStore;
  windowN?: number;
  minHits?: number;
  excludeSkill?: string;
}): PrewarmResult[] {
  const {
    userId,
    store,
    windowN = parseInt(process.env.BRAINROUTER_PREWARM_WINDOW ?? "10", 10),
    minHits = parseInt(process.env.BRAINROUTER_PREWARM_MIN_HITS ?? "3", 10),
    excludeSkill,
  } = params;

  // Guard: invalid config values fall back to defaults
  const safeWindow = isNaN(windowN) || windowN <= 0 ? 10 : windowN;
  const safeMinHits = isNaN(minHits) || minHits <= 0 ? 3 : minHits;

  const recentL1s = store.getRecentSkillContextL1s(userId, safeWindow);
  if (recentL1s.length === 0) return [];

  // Count occurrences per skill
  const hitCounts = new Map<string, number>();
  for (const { skillTag } of recentL1s) {
    if (!skillTag || skillTag === excludeSkill) continue;
    hitCounts.set(skillTag, (hitCounts.get(skillTag) ?? 0) + 1);
  }

  // Filter by minimum threshold and load hints
  const results: PrewarmResult[] = [];
  for (const [skillName, hitCount] of hitCounts.entries()) {
    if (hitCount < safeMinHits) continue;

    const hints = store.getSkillHints(skillName);
    if (!hints) continue; // No hints registered — nothing useful to inject

    results.push({ skillName, hitCount, hints });
  }

  // Sort by most active skill first
  results.sort((a, b) => b.hitCount - a.hitCount);
  return results;
}

/**
 * Build the `<skill-prewarm>` block for injection into `appendSystemContext`.
 * Returns an empty string if no skills qualify.
 */
export function buildPrewarmBlock(prewarmResults: PrewarmResult[]): string {
  if (prewarmResults.length === 0) return "";

  const sections = prewarmResults.map(({ skillName, hitCount, hints }) =>
    `  [${skillName}] (active ${hitCount}x recently)\n  ${hints.split("\n").join("\n  ")}`
  );

  return `<skill-prewarm>\n  Skills detected as recently active — hints pre-loaded:\n\n${sections.join("\n\n---\n\n")}\n</skill-prewarm>`;
}
