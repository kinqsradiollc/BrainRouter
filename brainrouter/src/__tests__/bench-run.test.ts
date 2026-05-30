import { describe, expect, it } from "vitest";
import { deriveBenchQuery, scoreRank, aggregateRanks } from "../memory/bench/run.js";

/** 0.4.3 (MEM-9) — retrieval-benchmark runner helpers (pure rank math). */

describe("deriveBenchQuery", () => {
  it("takes the first N salient words, collapsing whitespace", () => {
    expect(deriveBenchQuery("  The   quick brown fox jumps over the lazy dog", 4)).toBe("The quick brown fox");
  });
  it("is empty for empty/blank content", () => {
    expect(deriveBenchQuery("")).toBe("");
    expect(deriveBenchQuery("   ")).toBe("");
  });
});

describe("scoreRank (single relevant item)", () => {
  it("rank 0 = top hit on every metric (nDCG@10 = 1)", () => {
    const s = scoreRank(0);
    expect(s).toMatchObject({ r5: 1, r10: 1, r20: 1, mrr: 1 });
    expect(s.ndcg10).toBeCloseTo(1, 6);
  });
  it("rank 7 = misses @5, hits @10/@20; MRR = 1/8", () => {
    const s = scoreRank(7);
    expect(s).toMatchObject({ r5: 0, r10: 1, r20: 1 });
    expect(s.mrr).toBeCloseTo(1 / 8, 6);
    expect(s.ndcg10).toBeCloseTo(1 / Math.log2(9), 6);
  });
  it("rank beyond the windows: recall + nDCG zero, MRR still reflects the found rank", () => {
    const s = scoreRank(25);
    expect(s).toMatchObject({ r5: 0, r10: 0, r20: 0, ndcg10: 0 });
    expect(s.mrr).toBeCloseTo(1 / 26, 6); // found, just past every recall window
  });
  it("rank -1 (not found) is all zero", () => {
    expect(scoreRank(-1)).toMatchObject({ r5: 0, r10: 0, r20: 0, ndcg10: 0, mrr: 0 });
  });
});

describe("aggregateRanks", () => {
  it("means the per-query scores", () => {
    const s = aggregateRanks([0, -1]); // one perfect hit, one miss
    expect(s.recall_any_at_5).toBeCloseTo(0.5, 6);
    expect(s.recall_any_at_10).toBeCloseTo(0.5, 6);
    expect(s.mrr).toBeCloseTo(0.5, 6);
  });
  it("empty sample → all zeros (no NaN)", () => {
    expect(aggregateRanks([])).toEqual({ recall_any_at_5: 0, recall_any_at_10: 0, recall_any_at_20: 0, ndcg_at_10: 0, mrr: 0 });
  });
});
