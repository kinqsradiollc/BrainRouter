import { describe, expect, it } from "vitest";
import {
  halfLifeDecay,
  citationBoost,
  freshnessBoost,
  skillBoost,
  intentBoost,
  baseScoreFromRrf,
  normalizePriority,
  blendBaseAndPriority,
  effectivePriorityScore,
  DECAY_BASE,
  SKILL_BOOST,
  RRF_SCORE_SCALE,
  PRIORITY_SCALE,
  BASE_WEIGHT,
  PRIORITY_WEIGHT,
} from "../memory/reranker/index.js";

// --- Golden references: the EXACT inline formulas recall.ts used before the
// AUG-A3 extraction. The module must reproduce these bit-for-bit. ---

function oldEffectivePriority(priority: number, ageDays: number, halfLife: number | undefined, citation: number): number {
  let base = priority;
  if (halfLife) base = priority * Math.pow(0.5, ageDays / halfLife);
  const cb = Math.min((citation ?? 0) * 0.05, 0.3);
  const freshness = ageDays <= 1 ? 1 + 0.15 * (1 - ageDays) : 1;
  return base * (1 + cb) * freshness;
}

function oldLoopScore(rrf: number, effPriority: number, skillMatch: boolean, intentMult: number): number {
  const baseScore = rrf * 30;
  const priorityScore = effPriority / 100;
  let finalScore = baseScore * 0.7 + priorityScore * 0.3;
  if (skillMatch) finalScore *= 1.2;
  finalScore *= intentMult ?? 1;
  return finalScore;
}

describe("AUG-A3 reranker — constants match the original literals", () => {
  it("exposes the pre-refactor magic numbers", () => {
    expect(DECAY_BASE).toBe(0.5);
    expect(SKILL_BOOST).toBe(1.2);
    expect(RRF_SCORE_SCALE).toBe(30);
    expect(PRIORITY_SCALE).toBe(100);
    expect(BASE_WEIGHT).toBe(0.7);
    expect(PRIORITY_WEIGHT).toBe(0.3);
  });
});

describe("AUG-A3 reranker — pure facet behaviour", () => {
  it("halfLifeDecay: 1 at age 0, 0.5 at one half-life, 1 when no half-life", () => {
    expect(halfLifeDecay(0, 30)).toBeCloseTo(1, 10);
    expect(halfLifeDecay(30, 30)).toBeCloseTo(0.5, 10);
    expect(halfLifeDecay(100, 0)).toBe(1);
    expect(halfLifeDecay(100, undefined)).toBe(1);
  });

  it("citationBoost: linear then capped at 0.30", () => {
    expect(citationBoost(0)).toBe(0);
    expect(citationBoost(2)).toBeCloseTo(0.1, 10);
    expect(citationBoost(100)).toBe(0.3);
    expect(citationBoost(null)).toBe(0);
  });

  it("freshnessBoost: 1.15 at age 0 → 1.0 at age 1d → 1.0 beyond", () => {
    expect(freshnessBoost(0)).toBeCloseTo(1.15, 10);
    expect(freshnessBoost(0.5)).toBeCloseTo(1.075, 10);
    expect(freshnessBoost(1)).toBeCloseTo(1, 10);
    expect(freshnessBoost(5)).toBe(1);
  });

  it("skillBoost / intentBoost are no-ops in the default case", () => {
    expect(skillBoost(true)).toBe(1.2);
    expect(skillBoost(false)).toBe(1);
    expect(intentBoost(undefined)).toBe(1);
    expect(intentBoost(2.5)).toBe(2.5);
  });

  it("weighting helpers scale and blend as before", () => {
    expect(baseScoreFromRrf(0.02)).toBeCloseTo(0.6, 10);
    expect(normalizePriority(80)).toBeCloseTo(0.8, 10);
    expect(blendBaseAndPriority(10, 2)).toBeCloseTo(10 * 0.7 + 2 * 0.3, 10);
  });
});

describe("AUG-A3 reranker — characterization (no behaviour change)", () => {
  const grid = [
    { priority: 80, ageDays: 0, halfLife: 30, citation: 0 },
    { priority: 50, ageDays: 0.25, halfLife: 7, citation: 3 },
    { priority: 90, ageDays: 45, halfLife: 30, citation: 100 },
    { priority: 60, ageDays: 10, halfLife: undefined, citation: 1 },
    { priority: 100, ageDays: 2, halfLife: 365, citation: 12 },
  ];

  it("effectivePriorityScore reproduces the old inline formula", () => {
    for (const c of grid) {
      const got = effectivePriorityScore({
        priority: c.priority,
        ageDays: c.ageDays,
        halfLifeDays: c.halfLife,
        citationCount: c.citation,
      });
      expect(got).toBeCloseTo(oldEffectivePriority(c.priority, c.ageDays, c.halfLife, c.citation), 10);
    }
  });

  it("full loop score reproduces the old inline formula", () => {
    const cases = [
      { rrf: 0.0163, eff: 80, skill: false, intent: 1 },
      { rrf: 0.02, eff: 55, skill: true, intent: 1 },
      { rrf: 0.011, eff: 70, skill: false, intent: 1.5 },
      { rrf: 0.03, eff: 95, skill: true, intent: 0.8 },
    ];
    for (const c of cases) {
      const baseScore = baseScoreFromRrf(c.rrf);
      const priorityScore = normalizePriority(c.eff);
      let finalScore = blendBaseAndPriority(baseScore, priorityScore);
      if (c.skill) finalScore *= SKILL_BOOST;
      finalScore *= intentBoost(c.intent);
      expect(finalScore).toBeCloseTo(oldLoopScore(c.rrf, c.eff, c.skill, c.intent), 10);
    }
  });
});
