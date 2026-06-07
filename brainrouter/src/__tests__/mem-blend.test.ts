import { describe, expect, it } from "vitest";
import { readRerankBlendAlpha, minMaxNormalize } from "../memory/recall.js";

// MEM-BLEND (0.4.14) — blend the cross-encoder score with the pre-rerank
// (RRF + half-life recency) score instead of replacing the order.
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

describe("minMaxNormalize", () => {
  it("maps the min to 0 and the max to 1", () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
    expect(minMaxNormalize([-1, 0, 1])).toEqual([0, 0.5, 1]);
  });
  it("returns neutral 0.5 for a degenerate (all-equal) axis", () => {
    expect(minMaxNormalize([3, 3, 3])).toEqual([0.5, 0.5, 0.5]);
    expect(minMaxNormalize([7])).toEqual([0.5]);
  });
  it("handles empty input", () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
  it("produces a usable blend (alpha mixes the two normalized axes)", () => {
    // rel favors index 0, pre favors index 2; alpha=0.6 should let rel win at 0.
    const rel = minMaxNormalize([1.0, 0.5, 0.0]); // [1, .5, 0]
    const pre = minMaxNormalize([0.0, 0.5, 1.0]); // [0, .5, 1]
    const alpha = 0.6;
    const blend = rel.map((r, i) => alpha * r + (1 - alpha) * pre[i]);
    expect(blend[0]).toBeCloseTo(0.6); // 0.6*1 + 0.4*0
    expect(blend[2]).toBeCloseTo(0.4); // 0.6*0 + 0.4*1
    expect(blend[0]).toBeGreaterThan(blend[2]);
  });
});
