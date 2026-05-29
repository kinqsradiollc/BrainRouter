import { describe, expect, it } from "vitest";
import {
  resolveDedupMode,
  contentHash,
  cosineSim,
  isDuplicate,
  type DedupCandidate,
} from "../memory/pipeline/apply-dedup.js";

describe("AUG-A2 apply-time dedup", () => {
  it("resolveDedupMode defaults to off; accepts strict|fuzzy only", () => {
    expect(resolveDedupMode({})).toBe("off");
    expect(resolveDedupMode({ BRAINROUTER_DEDUP_MODE: "strict" })).toBe("strict");
    expect(resolveDedupMode({ BRAINROUTER_DEDUP_MODE: "FUZZY" })).toBe("fuzzy");
    expect(resolveDedupMode({ BRAINROUTER_DEDUP_MODE: "nonsense" })).toBe("off");
  });

  it("contentHash is stable + whitespace/case-insensitive", () => {
    expect(contentHash("Hello   World")).toBe(contentHash("hello world"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("cosineSim: identical=1, orthogonal=0", () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("off never drops", () => {
    const kept: DedupCandidate[] = [{ hash: "x" }];
    expect(isDuplicate("off", { hash: "x" }, kept)).toBe(false);
  });

  it("strict drops exact content-hash matches only", () => {
    const kept: DedupCandidate[] = [{ hash: "abc" }];
    expect(isDuplicate("strict", { hash: "abc" }, kept)).toBe(true);
    expect(isDuplicate("strict", { hash: "zzz" }, kept)).toBe(false);
  });

  it("fuzzy drops near-duplicates by cosine, and still catches exact hashes", () => {
    const kept: DedupCandidate[] = [{ hash: "a", embedding: [1, 0, 0] }];
    // Near-parallel embedding (cosine ~0.9998) → dropped.
    expect(isDuplicate("fuzzy", { hash: "b", embedding: [0.98, 0.02, 0] }, kept)).toBe(true);
    // Distinct embedding → kept.
    expect(isDuplicate("fuzzy", { hash: "c", embedding: [0, 1, 0] }, kept)).toBe(false);
    // Exact hash still drops even without embeddings.
    expect(isDuplicate("fuzzy", { hash: "a" }, kept)).toBe(true);
  });
});
