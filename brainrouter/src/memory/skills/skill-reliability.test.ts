import { describe, expect, it } from "vitest";
import {
  skillSuccessRate,
  shouldDemoteSkill,
  skillReliabilityFactor,
  SKILL_DEMOTION_FLOOR,
  MIN_USES_FOR_DEMOTION,
} from "./skill-reliability.js";

describe("ADR-020 D1 — skill reliability", () => {
  it("treats an unused skill as neutral (rate 1, factor ~1, never demoted)", () => {
    expect(skillSuccessRate({ usageCount: 0, successCount: 0 })).toBe(1);
    expect(shouldDemoteSkill({ usageCount: 0, successCount: 0 })).toBe(false);
    expect(skillReliabilityFactor({ usageCount: 0, successCount: 0 })).toBeCloseTo(1, 5);
  });

  it("computes a bounded success rate", () => {
    expect(skillSuccessRate({ usageCount: 10, successCount: 9 })).toBeCloseTo(0.9);
    expect(skillSuccessRate({ usageCount: 4, successCount: 0 })).toBe(0);
    // never exceeds 1 even with dirty counters
    expect(skillSuccessRate({ usageCount: 2, successCount: 5 })).toBe(1);
  });

  it("does not demote before enough evidence, even at 0% success", () => {
    expect(shouldDemoteSkill({ usageCount: MIN_USES_FOR_DEMOTION - 1, successCount: 0 })).toBe(false);
  });

  it("demotes a proven-flaky skill (>= MIN_USES and below the floor)", () => {
    expect(shouldDemoteSkill({ usageCount: 10, successCount: 3 })).toBe(true); // 0.3 < 0.4
    expect(shouldDemoteSkill({ usageCount: 10, successCount: 5 })).toBe(false); // 0.5 >= 0.4
    expect(SKILL_DEMOTION_FLOOR).toBe(0.4);
  });

  it("reliability factor rewards proven-good and penalises proven-bad, staying bounded", () => {
    const good = skillReliabilityFactor({ usageCount: 20, successCount: 20 });
    const bad = skillReliabilityFactor({ usageCount: 20, successCount: 0 });
    expect(good).toBeGreaterThan(1);
    expect(good).toBeLessThanOrEqual(1.25);
    expect(bad).toBeLessThan(1);
    expect(bad).toBeGreaterThanOrEqual(0.5);
    // thin evidence stays close to neutral
    const thin = skillReliabilityFactor({ usageCount: 1, successCount: 0 });
    expect(thin).toBeGreaterThan(bad);
  });
});
