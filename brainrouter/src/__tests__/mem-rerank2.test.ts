import { describe, expect, it } from "vitest";
import { readRerankCharBudget, rerankHeadSize } from "../memory/recall.js";

// MEM-RERANK2 (0.4.14) — char-budget the cross-encoder input (latency ∝ Σ
// doc-chars). Adapts to doc length: long docs → few candidates, short docs →
// the whole pool, so it never starves a deep-gold short-doc corpus.
describe("readRerankCharBudget", () => {
  it("defaults to 30000, parses, clamps to 500000, rejects junk / too-small", () => {
    expect(readRerankCharBudget({})).toBe(30000);
    expect(readRerankCharBudget({ BRAINROUTER_RECALL_RERANK_CHAR_BUDGET: "" })).toBe(30000);
    expect(readRerankCharBudget({ BRAINROUTER_RECALL_RERANK_CHAR_BUDGET: "30000" })).toBe(30000);
    expect(readRerankCharBudget({ BRAINROUTER_RECALL_RERANK_CHAR_BUDGET: "999999" })).toBe(500000);
    expect(readRerankCharBudget({ BRAINROUTER_RECALL_RERANK_CHAR_BUDGET: "100" })).toBe(30000); // below floor
    expect(readRerankCharBudget({ BRAINROUTER_RECALL_RERANK_CHAR_BUDGET: "junk" })).toBe(30000);
  });
});

describe("rerankHeadSize", () => {
  const maxDoc = 1500;
  it("long docs → few candidates fit the budget (latency cut)", () => {
    expect(rerankHeadSize(new Array(40).fill(1500), 18000, maxDoc)).toBe(12);
  });
  it("short docs → the whole pool fits (deep gold rescued)", () => {
    expect(rerankHeadSize(new Array(40).fill(300), 18000, maxDoc)).toBe(40); // 40*300=12000 < 18000
  });
  it("caps each doc at maxDocChars when budgeting", () => {
    expect(rerankHeadSize(new Array(40).fill(5000), 18000, maxDoc)).toBe(12); // counted as 1500 each
  });
  it("always returns at least 1, even if the first doc blows the budget", () => {
    expect(rerankHeadSize([100000], 1500, maxDoc)).toBe(1);
    expect(rerankHeadSize([], 18000, maxDoc)).toBe(1);
  });
});
