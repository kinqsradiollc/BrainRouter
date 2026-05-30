import { describe, expect, it } from "vitest";
import {
  tokenize,
  tokenSet,
  lexicalOverlap,
  jaccard,
  selectMMR,
  LEXICAL_SCORE_FLOOR,
} from "../memory/reranker/lexical.js";
import { readRecallSelection } from "../memory/recall.js";

/**
 * 0.4.3 recall selection stage (PR 3b): local lexical relevance + MMR
 * diversity for the default (no cross-encoder) path. These are what collapse
 * the "5× near-identical boilerplate fills the top-K" pathology without any
 * network/LLM call.
 */

describe("tokenize / overlap / jaccard", () => {
  it("drops stopwords and sub-3-char tokens", () => {
    expect(tokenize("Find all the vulnerabilities in our API")).toEqual(["find", "vulnerabilities", "api"]);
  });

  it("lexicalOverlap is ~0 for generic boilerplate vs a specific query, 1 for empty query", () => {
    const q = tokenSet("find all the vulnerabilities in our api");
    const boilerplate = tokenSet("BrainRouter is an autonomous software engineering agent");
    const onTopic = tokenSet("API key leakage vulnerabilities in the signin endpoint");
    expect(lexicalOverlap(q, boilerplate)).toBe(0);
    expect(lexicalOverlap(q, onTopic)).toBeGreaterThan(0);
    expect(lexicalOverlap(new Set(), boilerplate)).toBe(1); // no query signal → no penalty
  });

  it("jaccard: 1 identical, 0 disjoint, partial between", () => {
    const a = tokenSet("alpha beta gamma");
    expect(jaccard(a, tokenSet("alpha beta gamma"))).toBe(1);
    expect(jaccard(a, tokenSet("delta epsilon zeta"))).toBe(0);
    expect(jaccard(a, tokenSet("alpha beta delta"))).toBeGreaterThan(0);
    expect(jaccard(a, tokenSet("alpha beta delta"))).toBeLessThan(1);
  });
});

describe("selectMMR — mechanics", () => {
  const items = [
    { item: "a", score: 1.0, tokens: tokenSet("alpha beta gamma") },
    { item: "b", score: 0.9, tokens: tokenSet("delta epsilon zeta") },
    { item: "c", score: 0.8, tokens: tokenSet("eta theta iota") },
  ];
  it("lambda=1 is pure score order (no diversity penalty)", () => {
    expect(selectMMR(items, 3, 1)).toEqual(["a", "b", "c"]);
  });
  it("returns at most k and never more than the pool", () => {
    expect(selectMMR(items, 10, 0.7)).toHaveLength(3);
    expect(selectMMR(items, 2, 0.7)).toHaveLength(2);
  });
});

describe("lexical demotion + MMR (the real selection pipeline) collapses boilerplate", () => {
  // Mirrors what recall.ts does: adjust each candidate's score by query-overlap
  // FIRST (boilerplate shares ~0 query tokens → ×LEXICAL_SCORE_FLOOR), THEN MMR.
  const q = tokenSet("find all the vulnerabilities in our api");
  const raw = [
    { item: "boiler1", base: 1.0, tokens: tokenSet("BrainRouter is an autonomous software engineering agent") },
    { item: "boiler2", base: 0.98, tokens: tokenSet("BrainRouter is an autonomous software engineering agent named brainrouter") },
    { item: "boiler3", base: 0.96, tokens: tokenSet("BrainRouter is an autonomous software engineering agent designed for development") },
    { item: "bugfind", base: 0.70, tokens: tokenSet("vulnerabilities: API key leakage in auth signin admin responses") },
    { item: "secpol", base: 0.65, tokens: tokenSet("vulnerable api endpoint: jwt token validation missing on upload") },
  ];
  const candidates = raw.map((r) => ({
    item: r.item,
    score: r.base * (LEXICAL_SCORE_FLOOR + (1 - LEXICAL_SCORE_FLOOR) * lexicalOverlap(q, r.tokens)),
    tokens: r.tokens,
  }));

  it("on-topic findings beat higher-base boilerplate, and ≤1 boilerplate clone survives the top-3", () => {
    const picked = selectMMR(candidates, 3, 0.7);
    expect(picked).toContain("bugfind");
    expect(picked).toContain("secpol");
    expect(picked.filter((p) => p.startsWith("boiler")).length).toBeLessThanOrEqual(1);
  });
});

describe("the lexical multiplier flips boilerplate below an on-topic finding", () => {
  it("after the floor-blended lexical adjustment, the on-topic record out-scores higher-base boilerplate", () => {
    const q = tokenSet("find all the vulnerabilities in our api");
    const boilerplate = { base: 1.0, tokens: tokenSet("BrainRouter is an autonomous software engineering agent") };
    const finding = { base: 0.6, tokens: tokenSet("vulnerabilities: API key leakage in the signin endpoint") };
    const adj = (c: { base: number; tokens: Set<string> }) =>
      c.base * (LEXICAL_SCORE_FLOOR + (1 - LEXICAL_SCORE_FLOOR) * lexicalOverlap(q, c.tokens));
    expect(adj(boilerplate)).toBeLessThan(adj(finding));
  });
});

describe("readRecallSelection", () => {
  it("defaults: diversity on, lambda 0.7", () => {
    const s = readRecallSelection({} as NodeJS.ProcessEnv);
    expect(s.diversity).toBe(true);
    expect(s.lambda).toBe(0.7);
  });

  it("honors BRAINROUTER_RECALL_DIVERSITY=off and a valid lambda", () => {
    expect(readRecallSelection({ BRAINROUTER_RECALL_DIVERSITY: "off" } as never).diversity).toBe(false);
    expect(readRecallSelection({ BRAINROUTER_RECALL_DIVERSITY_LAMBDA: "0.4" } as never).lambda).toBe(0.4);
  });

  it("clamps an out-of-range / garbage lambda back to the default", () => {
    expect(readRecallSelection({ BRAINROUTER_RECALL_DIVERSITY_LAMBDA: "5" } as never).lambda).toBe(0.7);
    expect(readRecallSelection({ BRAINROUTER_RECALL_DIVERSITY_LAMBDA: "abc" } as never).lambda).toBe(0.7);
  });
});
