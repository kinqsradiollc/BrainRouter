import { describe, expect, it } from "vitest";
import { readRerankInputCap } from "../memory/recall.js";

// MEM-RERANK2 (0.4.14) — cap the cross-encoder input to the cheap-ranked head
// (latency ∝ candidates × doc length); the tail keeps its pre-score order.
describe("readRerankInputCap", () => {
  it("defaults to 12, parses an override, clamps to 200, rejects junk / <1", () => {
    expect(readRerankInputCap({})).toBe(12);
    expect(readRerankInputCap({ BRAINROUTER_RECALL_RERANK_INPUT_CAP: "" })).toBe(12);
    expect(readRerankInputCap({ BRAINROUTER_RECALL_RERANK_INPUT_CAP: "20" })).toBe(20);
    expect(readRerankInputCap({ BRAINROUTER_RECALL_RERANK_INPUT_CAP: "999" })).toBe(200);
    expect(readRerankInputCap({ BRAINROUTER_RECALL_RERANK_INPUT_CAP: "0" })).toBe(12);
    expect(readRerankInputCap({ BRAINROUTER_RECALL_RERANK_INPUT_CAP: "junk" })).toBe(12);
  });
});
