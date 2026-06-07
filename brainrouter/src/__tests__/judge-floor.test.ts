import { describe, expect, it } from "vitest";
import { applyJudgeFloor, readJudgeMinKeep } from "../memory/recall.js";

// MEM-JUDGE (0.4.14) — result floor so the relevance judge can't collapse recall
// to zero on long-session records it can't verify.
describe("applyJudgeFloor", () => {
  it("returns the judge's approvals unchanged when they meet the floor", () => {
    const pre = ["a", "b", "c", "d"];
    expect(applyJudgeFloor(pre, ["a", "c"], 1)).toEqual(["a", "c"]);
    expect(applyJudgeFloor(pre, ["a", "c"], 2)).toEqual(["a", "c"]);
  });

  it("backfills from pre-judge order (approvals first) when under the floor", () => {
    const pre = ["a", "b", "c", "d"];
    expect(applyJudgeFloor(pre, [], 1)).toEqual(["a"]); // total collapse → top-1 retriever
    expect(applyJudgeFloor(pre, [], 3)).toEqual(["a", "b", "c"]);
    expect(applyJudgeFloor(pre, ["c"], 3)).toEqual(["c", "a", "b"]); // keep approval, then top pre-judge
  });

  it("never exceeds the available candidates", () => {
    expect(applyJudgeFloor(["a"], [], 5)).toEqual(["a"]);
    expect(applyJudgeFloor([], [], 3)).toEqual([]);
  });

  it("minKeep <= 0 preserves the old collapse-to-zero behavior", () => {
    expect(applyJudgeFloor(["a", "b"], [], 0)).toEqual([]);
  });
});

describe("readJudgeMinKeep", () => {
  it("defaults to 1 (never return zero when there were candidates)", () => {
    expect(readJudgeMinKeep({})).toBe(1);
    expect(readJudgeMinKeep({ BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP: "" })).toBe(1);
  });
  it("parses a valid override and allows 0 (opt out)", () => {
    expect(readJudgeMinKeep({ BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP: "5" })).toBe(5);
    expect(readJudgeMinKeep({ BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP: "0" })).toBe(0);
  });
  it("falls back to 1 on junk / negative", () => {
    expect(readJudgeMinKeep({ BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP: "junk" })).toBe(1);
    expect(readJudgeMinKeep({ BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP: "-3" })).toBe(1);
  });
});
