import { describe, expect, it } from "vitest";
import type { IMemoryStore, SkillActivationRecord, SkillHintsRecord } from "@brainrouter/types";
import { detectPrewarmSkills, decayPotential, spikeSkill } from "../memory/pipeline/skill-prewarm.js";

class InMemoryActivationStore {
  private activations = new Map<string, SkillActivationRecord[]>();
  private hints = new Map<string, SkillHintsRecord>();
  public activationWriteCount = 0;

  getSkillActivations(userId: string): SkillActivationRecord[] {
    return [...(this.activations.get(userId) ?? [])].sort((a, b) => b.potential - a.potential);
  }

  upsertSkillActivations(userId: string, records: SkillActivationRecord[]): void {
    this.activationWriteCount += 1;
    const current = new Map((this.activations.get(userId) ?? []).map((record) => [record.skillName, record]));
    for (const record of records) {
      current.set(record.skillName, record);
    }
    this.activations.set(userId, [...current.values()]);
  }

  upsertSkillHints(skillName: string, hints: string, sourceFile = ""): void {
    this.hints.set(skillName, {
      skillName,
      hints,
      sourceFile,
      registeredAt: "2026-05-20T00:00:00.000Z",
    });
  }

  getSkillHints(skillName: string): string | null {
    return this.hints.get(skillName)?.hints ?? null;
  }
}

function createStore(): InMemoryActivationStore & IMemoryStore {
  return new InMemoryActivationStore() as InMemoryActivationStore & IMemoryStore;
}

describe("skill activation potential routing", () => {
  it("persists skill activations through the store contract", () => {
    const store = createStore();
    store.upsertSkillActivations("user-1", [
      { skillName: "testing-skill", potential: 1.25, lastDecayTime: "2026-05-20T00:00:00.000Z" },
    ]);

    expect(store.getSkillActivations("user-1")).toEqual([
      { skillName: "testing-skill", potential: 1.25, lastDecayTime: "2026-05-20T00:00:00.000Z" },
    ]);
    expect(store.getSkillActivations("user-2")).toEqual([]);
  });

  it("spikes a skill and caps potential at the configured maximum", () => {
    const store = createStore();
    const now = new Date("2026-05-20T00:00:00.000Z");

    spikeSkill({
      userId: "user-1",
      skillName: "incremental-implementation",
      store,
      now,
      config: { spikeAmount: 1, maxPotential: 2, minTurnDecay: 0, halfLifeMinutes: 10 },
    });
    spikeSkill({
      userId: "user-1",
      skillName: "incremental-implementation",
      store,
      now,
      config: { spikeAmount: 1.5, maxPotential: 2, minTurnDecay: 0, halfLifeMinutes: 10 },
    });

    expect(store.getSkillActivations("user-1")).toEqual([
      { skillName: "incremental-implementation", potential: 2, lastDecayTime: now.toISOString() },
    ]);
  });

  it("applies exponential decay by half-life and minimum per-turn decay", () => {
    const lastDecayTime = "2026-05-20T00:00:00.000Z";
    const thirtyMinutesLater = new Date("2026-05-20T00:30:00.000Z");
    const sameTurn = new Date(lastDecayTime);

    expect(decayPotential({
      potential: 4,
      lastDecayTime,
      now: thirtyMinutesLater,
      halfLifeMinutes: 10,
      minTurnDecay: 0,
    })).toBeCloseTo(0.5, 5);
    expect(decayPotential({
      potential: 4,
      lastDecayTime,
      now: sameTurn,
      halfLifeMinutes: 10,
      minTurnDecay: 0.05,
    })).toBeCloseTo(3.8, 5);
  });

  it("returns thresholded prewarm hints sorted by decayed potential without writing decay state", () => {
    const store = createStore();
    const now = new Date("2026-05-20T00:10:00.000Z");
    store.upsertSkillHints("testing-skill", "Test carefully", "testing/SKILL.md");
    store.upsertSkillHints("incremental-implementation", "Ship in small steps", "implementation/SKILL.md");
    store.upsertSkillActivations("user-1", [
      { skillName: "testing-skill", potential: 4, lastDecayTime: "2026-05-20T00:00:00.000Z" },
      { skillName: "incremental-implementation", potential: 2, lastDecayTime: "2026-05-20T00:00:00.000Z" },
      { skillName: "missing-hints", potential: 4, lastDecayTime: "2026-05-20T00:00:00.000Z" },
    ]);
    const writeCountBeforeDetect = store.activationWriteCount;

    const results = detectPrewarmSkills({
      userId: "user-1",
      store,
      now,
      threshold: 0.75,
      config: { halfLifeMinutes: 10, minTurnDecay: 0 },
    });

    expect(results.map((result) => result.skillName)).toEqual([
      "testing-skill",
      "incremental-implementation",
    ]);
    expect(results[0]!.potential).toBeCloseTo(2, 5);
    expect(results[1]!.potential).toBeCloseTo(1, 5);
    expect(store.activationWriteCount).toBe(writeCountBeforeDetect);
    expect(store.getSkillActivations("user-1").find((record) => record.skillName === "testing-skill")?.lastDecayTime)
      .toBe("2026-05-20T00:00:00.000Z");
  });
});
