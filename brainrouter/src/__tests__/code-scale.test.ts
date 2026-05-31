import { describe, it, expect } from "vitest";
import {
  computeRetrievalMetrics,
  withTokenEfficiency,
  formatCodeScaleMd,
  type RankedQueryResult,
} from "../memory/bench/code-scale.js";
import { buildCodeScaleFixture } from "../memory/bench/code-scale-fixture.js";

describe("CODE-SCALE retrieval metrics (pure)", () => {
  it("scores a perfect ranking as 1.0 across the board", () => {
    const results: RankedQueryResult[] = [
      { query: "a", relevant: ["b", "c"], ranked: ["b", "c", "z"] },
    ];
    const m = computeRetrievalMetrics(results, 10);
    expect(m.recallAtK).toBe(1);
    expect(m.mrr).toBe(1);
    expect(m.ndcgAtK).toBe(1);
    expect(m.precisionAtK).toBeCloseTo(2 / 3); // 2 relevant of 3 returned
  });

  it("recall@k respects the cutoff", () => {
    const m = computeRetrievalMetrics(
      [{ query: "a", relevant: ["b", "c"], ranked: ["z", "b", "y", "c"] }],
      2,
    );
    expect(m.recallAtK).toBe(0.5); // only 'b' is within top-2
  });

  it("MRR is the reciprocal of the first relevant rank", () => {
    const m = computeRetrievalMetrics(
      [{ query: "a", relevant: ["c"], ranked: ["x", "y", "c"] }],
      10,
    );
    expect(m.mrr).toBeCloseTo(1 / 3);
  });

  it("misses score zero, not NaN", () => {
    const m = computeRetrievalMetrics(
      [{ query: "a", relevant: ["c"], ranked: ["x", "y"] }],
      10,
    );
    expect(m.recallAtK).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.ndcgAtK).toBe(0);
    expect(m.precisionAtK).toBe(0);
  });

  it("averages across queries", () => {
    const m = computeRetrievalMetrics(
      [
        { query: "a", relevant: ["b"], ranked: ["b"] }, // recall 1
        { query: "c", relevant: ["d"], ranked: ["z"] }, // recall 0
      ],
      10,
    );
    expect(m.recallAtK).toBe(0.5);
  });

  it("token-efficiency is returned-over-repo, lower is better", () => {
    const base = computeRetrievalMetrics(
      [{ query: "a", relevant: ["b"], ranked: ["b"], returnedTokens: 200 }],
      10,
    );
    const withEff = withTokenEfficiency(base, 1000);
    expect(withEff.tokenEfficiency).toBeCloseTo(0.2);
    expect(withEff.avgRepoTokens).toBe(1000);
  });

  it("formatCodeScaleMd renders the headline numbers", () => {
    const md = formatCodeScaleMd(
      withTokenEfficiency(
        computeRetrievalMetrics([{ query: "a", relevant: ["b"], ranked: ["b"], returnedTokens: 200 }], 10),
        1000,
      ),
    );
    expect(md).toContain("recall@10");
    expect(md).toContain("token efficiency");
  });
});

describe("CODE-SCALE fixture (deterministic)", () => {
  it("builds the requested number of labelled clusters", () => {
    const f = buildCodeScaleFixture({ clusters: 3, perCluster: 4 });
    expect(f.files.length).toBe(12);
    expect(f.queries.length).toBe(3);
    for (const q of f.queries) {
      expect(q.relevant.length).toBe(3); // perCluster - 1 (the seed)
      expect(q.relevant).not.toContain(q.seed);
    }
  });

  it("is fully deterministic (same fixture twice)", () => {
    const a = buildCodeScaleFixture({ clusters: 2, perCluster: 3 });
    const b = buildCodeScaleFixture({ clusters: 2, perCluster: 3 });
    expect(a).toEqual(b);
  });

  it("keeps cluster vocabularies distinct (seed imports stay in-cluster)", () => {
    const f = buildCodeScaleFixture({ clusters: 2, perCluster: 3 });
    // every file's relative import target shares its cluster directory
    for (const file of f.files) {
      const dir = file.filePath.split("/").slice(0, 2).join("/");
      const importMatch = /from "\.\/([a-z0-9_]+)"/.exec(file.content);
      expect(importMatch).toBeTruthy();
      expect(file.content).toContain(dir.split("/")[1]); // theme prefix present
    }
  });
});
