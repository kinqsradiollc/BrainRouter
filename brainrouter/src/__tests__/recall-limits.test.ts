import { afterEach, describe, expect, it } from "vitest";
import { RECALL_LIMITS_DEFAULT, readRecallLimits } from "../memory/recall.js";

/**
 * Snapshot + restore env keys around each test so a typo'd value in
 * one case doesn't leak into the next.
 */
const KEYS = [
  "BRAINROUTER_RECALL_FTS_LIMIT",
  "BRAINROUTER_RECALL_VEC_LIMIT",
  "BRAINROUTER_RECALL_RERANK_POOL",
  "BRAINROUTER_RECALL_TOP_RESULTS",
];

function withEnv(patch: Record<string, string | undefined>): () => void {
  const prior: Record<string, string | undefined> = {};
  for (const k of KEYS) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const k of KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  };
}

describe("recall pipeline width knobs", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it("defaults match the documented 15/15/20/5", () => {
    restore = withEnv({
      BRAINROUTER_RECALL_FTS_LIMIT: undefined,
      BRAINROUTER_RECALL_VEC_LIMIT: undefined,
      BRAINROUTER_RECALL_RERANK_POOL: undefined,
      BRAINROUTER_RECALL_TOP_RESULTS: undefined,
    });
    const limits = readRecallLimits();
    expect(limits).toEqual(RECALL_LIMITS_DEFAULT);
    expect(limits.ftsLimit).toBe(15);
    expect(limits.vecLimit).toBe(15);
    expect(limits.rerankPool).toBe(20);
    expect(limits.topResults).toBe(5);
  });

  it("env vars override the defaults", () => {
    restore = withEnv({
      BRAINROUTER_RECALL_FTS_LIMIT: "30",
      BRAINROUTER_RECALL_VEC_LIMIT: "25",
      BRAINROUTER_RECALL_RERANK_POOL: "40",
      BRAINROUTER_RECALL_TOP_RESULTS: "10",
    });
    const limits = readRecallLimits();
    expect(limits.ftsLimit).toBe(30);
    expect(limits.vecLimit).toBe(25);
    expect(limits.rerankPool).toBe(40);
    expect(limits.topResults).toBe(10);
  });

  it("clamps absurd values to 200 so a typo doesn't blow up the judge call", () => {
    restore = withEnv({
      BRAINROUTER_RECALL_FTS_LIMIT: "9999",
      BRAINROUTER_RECALL_VEC_LIMIT: "100000",
      BRAINROUTER_RECALL_RERANK_POOL: "500",
      BRAINROUTER_RECALL_TOP_RESULTS: "9999",
    });
    const limits = readRecallLimits();
    expect(limits.ftsLimit).toBe(200);
    expect(limits.vecLimit).toBe(200);
    expect(limits.rerankPool).toBe(200);
    expect(limits.topResults).toBe(200);
  });

  it("rejects garbage / zero / negative and falls back to defaults", () => {
    restore = withEnv({
      BRAINROUTER_RECALL_FTS_LIMIT: "not-a-number",
      BRAINROUTER_RECALL_VEC_LIMIT: "0",
      BRAINROUTER_RECALL_RERANK_POOL: "-5",
      BRAINROUTER_RECALL_TOP_RESULTS: "",
    });
    const limits = readRecallLimits();
    expect(limits.ftsLimit).toBe(RECALL_LIMITS_DEFAULT.ftsLimit);
    expect(limits.vecLimit).toBe(RECALL_LIMITS_DEFAULT.vecLimit);
    expect(limits.rerankPool).toBe(RECALL_LIMITS_DEFAULT.rerankPool);
    expect(limits.topResults).toBe(RECALL_LIMITS_DEFAULT.topResults);
  });

  it("respects per-knob overrides independently", () => {
    restore = withEnv({
      BRAINROUTER_RECALL_FTS_LIMIT: "50",
      BRAINROUTER_RECALL_VEC_LIMIT: undefined,
      BRAINROUTER_RECALL_RERANK_POOL: undefined,
      BRAINROUTER_RECALL_TOP_RESULTS: "8",
    });
    const limits = readRecallLimits();
    expect(limits.ftsLimit).toBe(50);
    expect(limits.vecLimit).toBe(RECALL_LIMITS_DEFAULT.vecLimit);
    expect(limits.rerankPool).toBe(RECALL_LIMITS_DEFAULT.rerankPool);
    expect(limits.topResults).toBe(8);
  });
});
