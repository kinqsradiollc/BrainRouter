/**
 * Recall pipeline limit knobs. Each stage of the pipeline has a width
 * (how many candidates flow through) — these used to be hardcoded
 * `15 / 15 / 20 / 5` in this file, which meant any user wanting more
 * recall coverage had to patch the source. Now env-overridable:
 *
 *   BRAINROUTER_RECALL_FTS_LIMIT      (default 15)  Stage 1 FTS5 top-K
 *   BRAINROUTER_RECALL_VEC_LIMIT      (default 15)  Stage 1 vector top-K
 *   BRAINROUTER_RECALL_RERANK_POOL    (default 20)  Stage 2 reranker pool size
 *   BRAINROUTER_RECALL_TOP_RESULTS    (default 5)   final size when reranker is off
 *
 * Each is clamped to [1, 200] to keep a typo from blowing up the
 * downstream LLM-judge call. Reading env once per recall is fine —
 * recall is already an LLM-grade operation, the env read is in the
 * noise.
 */
function recallLimit(envName: string, defaultValue: number, max = 200): number {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, max);
}

export interface RecallLimits {
  ftsLimit: number;
  vecLimit: number;
  rerankPool: number;
  topResults: number;
}

export const RECALL_LIMITS_DEFAULT: RecallLimits = {
  ftsLimit: 15,
  vecLimit: 15,
  rerankPool: 20,
  topResults: 5,
};

export function readRecallLimits(): RecallLimits {
  return {
    ftsLimit: recallLimit('BRAINROUTER_RECALL_FTS_LIMIT', RECALL_LIMITS_DEFAULT.ftsLimit),
    vecLimit: recallLimit('BRAINROUTER_RECALL_VEC_LIMIT', RECALL_LIMITS_DEFAULT.vecLimit),
    rerankPool: recallLimit('BRAINROUTER_RECALL_RERANK_POOL', RECALL_LIMITS_DEFAULT.rerankPool),
    topResults: recallLimit('BRAINROUTER_RECALL_TOP_RESULTS', RECALL_LIMITS_DEFAULT.topResults),
  };
}

/**
 * 0.4.3 — selection-stage config for the no-cross-encoder (default) path:
 * lexical relevance demotion + MMR diversity. Both ON by default; tune via
 *   BRAINROUTER_RECALL_DIVERSITY        on|off  (default on)
 *   BRAINROUTER_RECALL_DIVERSITY_LAMBDA 0..1    (default 0.7 — relevance-leaning)
 * No effect when a cross-encoder reranker key is configured (that path wins).
 */
export interface RecallSelection {
  diversity: boolean;
  lambda: number;
}

export function readRecallSelection(env: NodeJS.ProcessEnv = process.env): RecallSelection {
  const diversity = env.BRAINROUTER_RECALL_DIVERSITY?.trim().toLowerCase() !== 'off';
  const rawLambda = Number.parseFloat(env.BRAINROUTER_RECALL_DIVERSITY_LAMBDA ?? '');
  const lambda = Number.isFinite(rawLambda) && rawLambda >= 0 && rawLambda <= 1 ? rawLambda : 0.7;
  return { diversity, lambda };
}

/**
 * MEM-JUDGE (0.4.14) — result floor for the relevance judge. On long-session
 * records the small judge can't verify an answer buried in a 2.6k-token session
 * (it also only sees the first 600 chars), so it "when in doubt, reject"s every
 * candidate and recall collapses to ~0 (LongMemEval judge R@5 0.80 → 0.10). The
 * floor keeps at least `minKeep` top pre-judge results when the judge
 * under-delivers, so recall never drops below the retriever on a query that had
 * candidates. The judge's precision trimming on short records is untouched
 * (it only kicks in when approvals < minKeep).
 *   BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP  (default 1; 0 = old collapse-to-zero)
 */
export function readJudgeMinKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * Keep the judge's approved results, but if it approved fewer than `minKeep`,
 * backfill from the rank-ordered pre-judge list (approvals first, then the
 * next-best retriever results) so the set never collapses below the floor.
 * Pure + order-preserving; `approved` must be a subset of `preJudge`.
 */
export function applyJudgeFloor<T>(preJudge: T[], approved: T[], minKeep: number): T[] {
  if (minKeep <= 0 || approved.length >= minKeep || preJudge.length === 0) return approved;
  const out = [...approved];
  const have = new Set<T>(approved);
  for (const item of preJudge) {
    if (out.length >= minKeep) break;
    if (!have.has(item)) { out.push(item); have.add(item); }
  }
  return out;
}

/**
 * MEM-JUDGE2 (0.4.14) — how the relevance judge applies its verdicts:
 *   "reorder" (default) — recall-safe: keep every candidate and move the
 *                         approved ones to the front. The top-K slice still
 *                         gets a precision-ordered set, but recall@k can never
 *                         drop below the retriever (fixes the LongMemEval
 *                         judge R@k collapse where R@5=R@10=R@20).
 *   "filter"            — legacy precision-max: drop the rejects, floored by
 *                         BRAINROUTER_RELEVANCE_JUDGE_MIN_KEEP so it can't hit 0.
 *   BRAINROUTER_RELEVANCE_JUDGE_MODE
 */
export function readJudgeMode(env: NodeJS.ProcessEnv = process.env): "reorder" | "filter" {
  return env.BRAINROUTER_RELEVANCE_JUDGE_MODE?.trim().toLowerCase() === "filter" ? "filter" : "reorder";
}

/**
 * MEM-JUDGE2 (0.4.14) — recall-safe judge application. Return a permutation of
 * `preJudge`: the judge-approved records first (in the judge's order, deduped),
 * then every remaining record in its original retriever order. Records the judge
 * never saw (beyond its candidate window) or rejected are demoted, not dropped,
 * so the caller's top-K slice loses no recall. Pure + total.
 */
export function reorderApprovedFirst<T>(preJudge: T[], approvedIndices: number[]): T[] {
  if (preJudge.length === 0) return [];
  const approvedSet = new Set<number>();
  const approved: T[] = [];
  for (const i of approvedIndices) {
    if (Number.isInteger(i) && i >= 0 && i < preJudge.length && !approvedSet.has(i)) {
      approvedSet.add(i);
      approved.push(preJudge[i]);
    }
  }
  const rest: T[] = [];
  for (let i = 0; i < preJudge.length; i++) {
    if (!approvedSet.has(i)) rest.push(preJudge[i]);
  }
  return [...approved, ...rest];
}

/**
 * MEM-BLEND (0.4.14) — weight of the cross-encoder relevance vs the pre-rerank
 * score (RRF + half-life recency) when combining them by reciprocal rank.
 * 1 = pure reranker; 0 = pure retriever order. Default **1.0** (pure reranker):
 * on reranker-favorable queries (factual / conversational) blending in the
 * weaker lexical order only hurts, so the safe global default is to trust the
 * reranker and let MEM-ROUTE *lower* alpha for the query types where the
 * retriever/recency should win (reflective / synthesis). Clamp [0,1].
 *   BRAINROUTER_RECALL_RERANK_BLEND_ALPHA
 */
export function readRerankBlendAlpha(env: NodeJS.ProcessEnv = process.env): number {
  const def = 1.0;
  const raw = env.BRAINROUTER_RECALL_RERANK_BLEND_ALPHA;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}

/** RRF constant for rank-based blending (matches the fusion stage's k). */
export const RERANK_BLEND_K = 60;

/**
 * MEM-BLEND (0.4.14) — combine the reranker order with the pre-rerank order by
 * *reciprocal rank*, not raw score. Cross-encoder scores are bimodal (~1 for a
 * hit, ~0 otherwise), so a min-max score blend just reproduces the reranker
 * order and `alpha` does nothing; blending positions instead makes `alpha`
 * actually trade off relevance vs the retriever (RRF + recency). Input is in
 * pre-score order (so preRank = i); `rerankRank[i]` is item i's position in the
 * reranker order. Returns item indices, best blended first.
 */
export function blendByRank(rerankRank: number[], alpha: number, k: number = RERANK_BLEND_K): number[] {
  const n = rerankRank.length;
  return Array.from({ length: n }, (_, i) => i)
    .map((i) => ({ i, s: alpha * (1 / (k + rerankRank[i])) + (1 - alpha) * (1 / (k + i)) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

/**
 * MEM-RERANK2 (0.4.14) — total character budget sent to the cross-encoder.
 * Reranker latency ∝ Σ doc-chars, and it's the recall-latency bottleneck on
 * long-session corpora (longmemeval 22-28s). A fixed *count* cap is wrong: it
 * starves short-doc/deep-gold corpora (locomo gold sits at pre-rank 20-40, so
 * capping to 12 drops recall) while not helping enough on long docs. A *char*
 * budget adapts — long docs (longmemeval, ~1500 ch/chunk) → few candidates
 * (latency cut, and that corpus's gold is shallow), short docs (locomo, a few
 * hundred ch) → the whole pool (deep gold still rescued). Default 30000 chars
 * (~20 max-length chunks): tuned so long-session recall fully recovers (R@5/10
 * back to the all-pool baseline) while still cutting latency ~1.5× (22.7s →
 * 14.8s on longmemeval); short-doc corpora are unaffected (already under it).
 * Clamp [1500, 500000].
 *   BRAINROUTER_RECALL_RERANK_CHAR_BUDGET
 */
export function readRerankCharBudget(env: NodeJS.ProcessEnv = process.env): number {
  const def = 30000;
  const raw = env.BRAINROUTER_RECALL_RERANK_CHAR_BUDGET;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1500 ? Math.min(n, 500000) : def;
}

/**
 * How many leading (pre-score-ordered) candidates fit in the reranker char
 * budget — each doc costs min(its length, maxDocChars). Always ≥1 so the
 * reranker still runs; the rest are kept in pre-score order by the caller.
 */
export function rerankHeadSize(docLens: number[], budgetChars: number, maxDocChars: number): number {
  let total = 0;
  let n = 0;
  for (const len of docLens) {
    const eff = Math.min(Math.max(0, len), maxDocChars);
    if (n > 0 && total + eff > budgetChars) break;
    total += eff;
    n++;
  }
  return Math.max(1, Math.min(n, docLens.length || 1));
}

/**
 * MEM-ROUTE (0.4.14) — detect reflective / analytical queries ("most likely
 * sentiment", "how do they feel", "overall pattern", "summarize their attitude").
 * Their gold evidence has low surface overlap with the question, so the
 * cross-encoder demotes it — and on these the retriever+judge path already beats
 * the reranker (os-rm judge R-any@10 0.87 vs reranker 0.77). We route reflective
 * queries around the cross-encoder; factual / conversational keep it.
 */
const REFLECTIVE_QUERY_RE = /\b(sentiment|mood|emotions?|emotional|feel(s|ing|ings)?|attitude|opinion|tone|most likely|tend(s|ed)? to|usually|typically|overall|in general|generally|pattern|patterns|summar(y|ize|ise)|reflect|state of mind|disposition|outlook|impression)\b/i;

export function isReflectiveQuery(query: string): boolean {
  return REFLECTIVE_QUERY_RE.test(query ?? "");
}

/**
 * MEM-ROUTE — query-type routing toggle. Default on (heuristic); set
 * BRAINROUTER_RECALL_QUERY_ROUTING=off to always run the cross-encoder.
 */
export function readQueryRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAINROUTER_RECALL_QUERY_ROUTING?.trim().toLowerCase() !== "off";
}
