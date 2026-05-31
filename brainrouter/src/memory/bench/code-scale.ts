/**
 * CODE-SCALE (0.4.5) — repo-scale code-retrieval metrics for `find_related`.
 *
 * The code-recall bench (MEM-25, `code-recall.ts`) measures *chunking* quality
 * (does the chunker isolate the right symbols?). This measures *retrieval*
 * quality at repo scale: given a labelled set of queries (seed file → the files
 * that are genuinely related to it), how well does `find_related`'s ranking
 * surface the relevant files, and how token-efficient is the result vs. dumping
 * the whole repo?
 *
 * This module is PURE — it scores a ranked result list against a relevance
 * label set. The engine wrapper (`runCodeScaleBenchmark`) builds the fixture,
 * drives `find_related`, and feeds the rankings here.
 */

export interface RankedQueryResult {
  /** Label for the query (e.g. the seed file). */
  query: string;
  /** Files genuinely relevant to the query (the gold set). */
  relevant: string[];
  /** Files returned by find_related, best-first (deduped, in rank order). */
  ranked: string[];
  /** Total tokens across the returned chunks (for token-efficiency). */
  returnedTokens?: number;
}

export interface RetrievalMetrics {
  queries: number;
  /** Mean fraction of relevant files appearing in the top-k. */
  recallAtK: number;
  /** Mean fraction of top-k that are relevant. */
  precisionAtK: number;
  /** Mean reciprocal rank of the first relevant hit. */
  mrr: number;
  /** Mean normalized DCG at k (binary relevance). */
  ndcgAtK: number;
  /** The k the metrics were computed at. */
  k: number;
  /** Mean tokens returned per query (undefined if not measured). */
  avgReturnedTokens?: number;
  /** Mean tokens a whole-repo dump would cost per query (undefined if not measured). */
  avgRepoTokens?: number;
  /** avgReturnedTokens / avgRepoTokens — lower is better (undefined if not measured). */
  tokenEfficiency?: number;
}

function recallAtK(relevant: string[], ranked: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  const hits = relevant.filter((r) => top.has(r)).length;
  return hits / relevant.length;
}

function precisionAtK(relevant: string[], ranked: string[], k: number): number {
  if (k === 0) return 0;
  const rel = new Set(relevant);
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((f) => rel.has(f)).length;
  return hits / top.length;
}

function reciprocalRank(relevant: string[], ranked: string[]): number {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Binary-relevance nDCG@k. IDCG uses min(#relevant, k) ideal positions. */
function ndcgAtK(relevant: string[], ranked: string[], k: number): number {
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (rel.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(relevant.length, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Score a set of ranked query results against their relevance labels. */
export function computeRetrievalMetrics(results: RankedQueryResult[], k = 10): RetrievalMetrics {
  const recalls: number[] = [];
  const precisions: number[] = [];
  const rrs: number[] = [];
  const ndcgs: number[] = [];
  const returnedTokens: number[] = [];
  for (const r of results) {
    recalls.push(recallAtK(r.relevant, r.ranked, k));
    precisions.push(precisionAtK(r.relevant, r.ranked, k));
    rrs.push(reciprocalRank(r.relevant, r.ranked));
    ndcgs.push(ndcgAtK(r.relevant, r.ranked, k));
    if (typeof r.returnedTokens === "number") returnedTokens.push(r.returnedTokens);
  }
  const metrics: RetrievalMetrics = {
    queries: results.length,
    recallAtK: mean(recalls),
    precisionAtK: mean(precisions),
    mrr: mean(rrs),
    ndcgAtK: mean(ndcgs),
    k,
  };
  if (returnedTokens.length) metrics.avgReturnedTokens = mean(returnedTokens);
  return metrics;
}

/** Attach repo-dump token cost so token-efficiency can be reported. */
export function withTokenEfficiency(metrics: RetrievalMetrics, repoTokensPerQuery: number): RetrievalMetrics {
  if (!metrics.avgReturnedTokens || repoTokensPerQuery <= 0) return metrics;
  return {
    ...metrics,
    avgRepoTokens: repoTokensPerQuery,
    tokenEfficiency: metrics.avgReturnedTokens / repoTokensPerQuery,
  };
}

/** Markdown summary for the published numbers file. */
export function formatCodeScaleMd(m: RetrievalMetrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "# Code-scale retrieval benchmark (find_related ranking)",
    "",
    `- queries: ${m.queries}`,
    `- recall@${m.k}: **${pct(m.recallAtK)}**`,
    `- precision@${m.k}: ${pct(m.precisionAtK)}`,
    `- MRR: ${m.mrr.toFixed(3)}`,
    `- nDCG@${m.k}: ${m.ndcgAtK.toFixed(3)}`,
  ];
  if (typeof m.avgReturnedTokens === "number") {
    lines.push(`- avg tokens returned/query: ${Math.round(m.avgReturnedTokens)}`);
  }
  if (typeof m.tokenEfficiency === "number") {
    lines.push(
      `- token efficiency: **${pct(m.tokenEfficiency)}** of a whole-repo dump ` +
        `(${Math.round(m.avgReturnedTokens ?? 0)} vs ${Math.round(m.avgRepoTokens ?? 0)} tokens)`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
