/**
 * LongMemEval metric helpers.
 *
 * These are standard metric helpers for evaluation.
 */

/**
 * recall_any@K — 1.0 if ANY gold session appears in the top-K retrieved
 * sessions, otherwise 0.0.
 */
export function recallAny(
  retrievedIds: string[],
  goldIds: string[],
  k: number,
): number {
  const topK = new Set(retrievedIds.slice(0, k));
  return goldIds.some((gid) => topK.has(gid)) ? 1.0 : 0.0;
}

/** Discounted Cumulative Gain at K. */
function dcg(relevances: boolean[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    sum += (relevances[i] ? 1 : 0) / Math.log2(i + 2);
  }
  return sum;
}

/** Normalized Discounted Cumulative Gain at K. */
export function ndcg(
  retrievedIds: string[],
  goldSet: Set<string>,
  k: number,
): number {
  const rels = retrievedIds.slice(0, k).map((id) => goldSet.has(id));
  const idealRels = Array.from({ length: Math.min(k, goldSet.size) }, () => true);
  const idealDCG = dcg(idealRels, k);
  if (idealDCG === 0) return 0;
  return dcg(rels, k) / idealDCG;
}

/** Mean Reciprocal Rank — rank of the first gold session in results. */
export function mrr(retrievedIds: string[], goldSet: Set<string>): number {
  for (let i = 0; i < retrievedIds.length; i++) {
    if (goldSet.has(retrievedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface BenchResult {
  question_id: string;
  question_type: string;
  recall_any_at_5: number;
  recall_any_at_10: number;
  recall_any_at_20: number;
  ndcg_at_10: number;
  mrr: number;
  retrieved_session_ids: string[];
  gold_session_ids: string[];
}

/** Aggregate a list of per-question BenchResults into summary stats. */
export interface AggregateStats {
  questions: number;
  recall_any_at_5: number;
  recall_any_at_10: number;
  recall_any_at_20: number;
  ndcg_at_10: number;
  mrr: number;
  per_type: Record<
    string,
    { count: number; recall_any_at_5: number; recall_any_at_10: number }
  >;
}

export function aggregate(results: BenchResult[]): AggregateStats {
  const avg = (fn: (r: BenchResult) => number) =>
    results.reduce((s, r) => s + fn(r), 0) / results.length;

  const byType = new Map<string, BenchResult[]>();
  for (const r of results) {
    if (!byType.has(r.question_type)) byType.set(r.question_type, []);
    byType.get(r.question_type)!.push(r);
  }

  const per_type: AggregateStats["per_type"] = {};
  for (const [type, tr] of byType) {
    per_type[type] = {
      count: tr.length,
      recall_any_at_5: tr.reduce((s, r) => s + r.recall_any_at_5, 0) / tr.length,
      recall_any_at_10: tr.reduce((s, r) => s + r.recall_any_at_10, 0) / tr.length,
    };
  }

  return {
    questions: results.length,
    recall_any_at_5: avg((r) => r.recall_any_at_5),
    recall_any_at_10: avg((r) => r.recall_any_at_10),
    recall_any_at_20: avg((r) => r.recall_any_at_20),
    ndcg_at_10: avg((r) => r.ndcg_at_10),
    mrr: avg((r) => r.mrr),
    per_type,
  };
}
