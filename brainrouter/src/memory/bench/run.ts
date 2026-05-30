/**
 * 0.4.3 (MEM-9) — retrieval benchmark runner (the half that produces the
 * per-mode aggregate stats `regression.ts` then gates + formats).
 *
 * Strategy: SELF-RETRIEVAL on the user's real records — no synthetic corpus, no
 * ground-truth labels (there are none locally). For each sampled record we
 * derive a realistic *partial* query from its content and ask recall to find it
 * back; the metric is whether the source record resurfaces, and at what rank.
 * That measures real recall quality and, run before/after a change, catches
 * regressions — which is exactly what the regression gate is for.
 *
 * These helpers are pure (rank math + query derivation); the orchestration
 * (sampling, running recall per mode, writing the summary) lives on the engine
 * so this stays unit-testable without a store.
 */

import type { ModeStats } from "./regression.js";

/**
 * Derive a realistic partial query from a record's content: the first
 * `maxWords` whitespace tokens. Not a verbatim match (so retrieval has to
 * work), but enough signal that a healthy index resurfaces the record.
 */
export function deriveBenchQuery(content: string, maxWords = 12): string {
  return (content ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, maxWords).join(" ");
}

export interface RankScore {
  r5: number;
  r10: number;
  r20: number;
  ndcg10: number;
  mrr: number;
}

/**
 * Single-relevant-item retrieval metrics from a 0-based rank (-1 = not found).
 * With exactly one relevant document the ideal DCG is 1, so nDCG@10 collapses
 * to the gain of the single hit if it lands in the top 10.
 */
export function scoreRank(rank: number): RankScore {
  const hitWithin = (k: number) => (rank >= 0 && rank < k ? 1 : 0);
  return {
    r5: hitWithin(5),
    r10: hitWithin(10),
    r20: hitWithin(20),
    ndcg10: rank >= 0 && rank < 10 ? 1 / Math.log2(rank + 2) : 0,
    mrr: rank >= 0 ? 1 / (rank + 1) : 0,
  };
}

/** Mean the per-query rank scores into a `ModeStats` row. Empty → all zeros. */
export function aggregateRanks(ranks: number[]): ModeStats {
  const n = ranks.length;
  if (n === 0) {
    return { recall_any_at_5: 0, recall_any_at_10: 0, recall_any_at_20: 0, ndcg_at_10: 0, mrr: 0 };
  }
  const scored = ranks.map(scoreRank);
  const mean = (sel: (s: RankScore) => number) => scored.reduce((acc, s) => acc + sel(s), 0) / n;
  return {
    recall_any_at_5: mean((s) => s.r5),
    recall_any_at_10: mean((s) => s.r10),
    recall_any_at_20: mean((s) => s.r20),
    ndcg_at_10: mean((s) => s.ndcg10),
    mrr: mean((s) => s.mrr),
  };
}
