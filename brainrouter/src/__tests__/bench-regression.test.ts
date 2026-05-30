import { describe, it, expect } from "vitest";
import { checkThresholds, formatModesSummaryMd, type ModeStats } from "../memory/bench/regression.js";

const fts: ModeStats = { recall_any_at_5: 0.40, recall_any_at_10: 0.55, recall_any_at_20: 0.70, ndcg_at_10: 0.42, mrr: 0.38 };
const hybrid: ModeStats = { recall_any_at_5: 0.50, recall_any_at_10: 0.65, recall_any_at_20: 0.80, ndcg_at_10: 0.51, mrr: 0.47 };

describe("retrieval benchmark regression gate (MEM-9)", () => {
  it("passes when every thresholded metric meets its bar", () => {
    const r = checkThresholds({ fts, hybrid }, { fts: { recall_any_at_10: 0.5 }, hybrid: { recall_any_at_10: 0.6, mrr: 0.4 } });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails (with a readable reason) when a metric is below its bar", () => {
    const r = checkThresholds({ fts }, { fts: { recall_any_at_10: 0.9 } });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/fts\.recall_any_at_10 55\.0% < min 90\.0%/);
  });

  it("fails when a thresholded mode has no results", () => {
    const r = checkThresholds({ fts }, { hybrid: { mrr: 0.1 } });
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("hybrid: no results");
  });

  it("renders a markdown comparison table over modes", () => {
    const md = formatModesSummaryMd({ fts, hybrid });
    expect(md).toMatch(/\| Mode \| Recall@5 \| Recall@10 \| Recall@20 \| nDCG@10 \| MRR \|/);
    expect(md).toMatch(/\| fts \| 40\.0% \| 55\.0% \| 70\.0% \| 42\.0% \| 38\.0% \|/);
    expect(md).toMatch(/\| hybrid \| 50\.0% \| 65\.0% \| 80\.0% \| 51\.0% \| 47\.0% \|/);
  });
});
