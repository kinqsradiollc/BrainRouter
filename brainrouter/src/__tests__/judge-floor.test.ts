import { describe, expect, it } from "vitest";
import { applyJudgeFloor, readJudgeMinKeep, readJudgeMode, reorderApprovedFirst } from "../memory/recall.js";
import { judgeDocChars } from "../memory/store/relevance-judge.js";

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

// MEM-JUDGE2 (0.4.14) — recall-safe reorder instead of drop-filter.
describe("reorderApprovedFirst", () => {
  it("keeps every candidate, moving approvals to the front in judge order", () => {
    const pre = ["a", "b", "c", "d", "e"];
    // judge approved indices 3 then 1 → those first (judge order), rest in original order
    expect(reorderApprovedFirst(pre, [3, 1])).toEqual(["d", "b", "a", "c", "e"]);
  });

  it("is a no-op ordering when nothing is approved — recall fully preserved", () => {
    const pre = ["a", "b", "c"];
    expect(reorderApprovedFirst(pre, [])).toEqual(["a", "b", "c"]);
  });

  it("keeps the un-judged / rejected tail (never drops below input length)", () => {
    const pre = ["a", "b", "c", "d"];
    // judge only saw + approved index 0 (e.g. maxCandidates window) → rest still kept
    const out = reorderApprovedFirst(pre, [0]);
    expect(out).toHaveLength(4);
    expect(out).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes and ignores out-of-range / non-integer indices", () => {
    const pre = ["a", "b", "c"];
    expect(reorderApprovedFirst(pre, [2, 2, 9, -1, 1.5])).toEqual(["c", "a", "b"]);
  });

  it("handles empty input", () => {
    expect(reorderApprovedFirst([], [0, 1])).toEqual([]);
  });
});

describe("readJudgeMode", () => {
  it("defaults to recall-safe reorder", () => {
    expect(readJudgeMode({})).toBe("reorder");
    expect(readJudgeMode({ BRAINROUTER_RELEVANCE_JUDGE_MODE: "" })).toBe("reorder");
    expect(readJudgeMode({ BRAINROUTER_RELEVANCE_JUDGE_MODE: "anything-else" })).toBe("reorder");
  });
  it("opts into legacy filter mode (case/space tolerant)", () => {
    expect(readJudgeMode({ BRAINROUTER_RELEVANCE_JUDGE_MODE: "filter" })).toBe("filter");
    expect(readJudgeMode({ BRAINROUTER_RELEVANCE_JUDGE_MODE: " FILTER " })).toBe("filter");
  });
});

describe("judgeDocChars", () => {
  it("defaults to 1200 (up from the old 600), parses, clamps, rejects junk", () => {
    expect(judgeDocChars({})).toBe(1200);
    expect(judgeDocChars({ BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS: "800" })).toBe(800);
    expect(judgeDocChars({ BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS: "99999" })).toBe(4000);
    expect(judgeDocChars({ BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS: "50" })).toBe(1200); // below floor → default
    expect(judgeDocChars({ BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS: "junk" })).toBe(1200);
  });
});
