import { describe, expect, it } from "vitest";
import { readRerankBlendAlpha, blendByRank } from "../memory/recall.js";

// MEM-BLEND (0.4.14) — blend the cross-encoder order with the pre-rerank
// (RRF + half-life recency) order by reciprocal rank, so the reranker refines
// rather than replaces the retriever (and recency survives).
describe("readRerankBlendAlpha", () => {
  it("defaults to 0.6, parses, allows the [0,1] endpoints", () => {
    expect(readRerankBlendAlpha({})).toBe(0.6);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "" })).toBe(0.6);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "0.8" })).toBe(0.8);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "0" })).toBe(0);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "1" })).toBe(1);
  });
  it("falls back to default on out-of-range / junk", () => {
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "1.5" })).toBe(0.6);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "-0.2" })).toBe(0.6);
    expect(readRerankBlendAlpha({ BRAINROUTER_RECALL_RERANK_BLEND_ALPHA: "junk" })).toBe(0.6);
  });
});

describe("blendByRank", () => {
  it("alpha=1 reproduces the reranker order", () => {
    // item0 ranked #1 by reranker, item1 #2, item2 #0
    expect(blendByRank([1, 2, 0], 1)).toEqual([2, 0, 1]);
  });
  it("alpha=0 reproduces the pre-score (input) order", () => {
    expect(blendByRank([2, 0, 1], 0)).toEqual([0, 1, 2]);
  });
  it("low alpha rescues retriever-favored gold the reranker demoted (reflective case)", () => {
    // item0 = gold: best by pre-score (rank 0) but reranker buries it (rank 1);
    // item1 = reranker's favorite but pre-score-weak.
    const rerankRank = [1, 0];
    expect(blendByRank(rerankRank, 0.9)[0]).toBe(1); // high alpha → reranker wins
    expect(blendByRank(rerankRank, 0.1)[0]).toBe(0); // low alpha  → gold rescued
  });
  it("is a total permutation of the indices", () => {
    expect(blendByRank([3, 1, 0, 2], 0.6).slice().sort()).toEqual([0, 1, 2, 3]);
  });
  it("handles empty input", () => {
    expect(blendByRank([], 0.6)).toEqual([]);
  });
});
