/**
 * 0.4.3 — local, no-network lexical relevance + MMR diversity for the recall
 * SELECTION stage.
 *
 * On the default install no cross-encoder reranker API key is configured, so
 * the final top-K was taken purely by the RRF + priority + spark composite —
 * which lets several near-identical, high-priority records ("BrainRouter is an
 * autonomous agent…") fill every slot and bury on-topic findings. Without a
 * network reranker we still get two cheap, deterministic signals from text
 * already in hand:
 *
 *   - lexicalOverlap — demote candidates that share few salient tokens with
 *     the query (generic boilerplate vs a specific query → ~0).
 *   - MMR selection  — pick a DIVERSE top-K; a near-duplicate of an already
 *     chosen item has Jaccard≈1, so its marginal value collapses. This is what
 *     stops 5 paraphrases of the same record filling the top-K.
 *
 * Pure + synchronous — zero added latency (token-set math, no I/O, no model).
 */

// Minimal English stopword set — enough to keep "the/is/an/our" from dominating
// the overlap signal. Intentionally small: this is a relevance nudge layered on
// top of the existing FTS+vector retrieval, not a search engine.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "it", "its", "as", "at", "by", "from", "into", "our", "your", "their",
  "my", "we", "you", "they", "he", "she", "i", "do", "does", "did", "how",
  "what", "why", "when", "where", "which", "who", "all", "any", "can", "could",
  "should", "would", "will", "not", "no", "yes", "if", "then", "than", "so",
  "about", "over", "under", "out", "up", "down", "here", "there", "some", "more",
]);

/** Lowercase, split on non-alphanumeric, drop stopwords + tokens under 3 chars. */
export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Query-term recall: the fraction of the query's salient tokens that appear in
 * the document. ~0 when a generic record shares no salient token with a
 * specific query; 1 for an empty query (no signal to apply, so don't penalize).
 */
export function lexicalOverlap(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0) return 1;
  let hit = 0;
  for (const q of queryTokens) if (docTokens.has(q)) hit++;
  return hit / queryTokens.size;
}

/** Token-set Jaccard similarity in [0,1] — the MMR diversity / near-dup metric. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface MmrCandidate<T> {
  item: T;
  /** Base relevance score (already lexical-adjusted by the caller). */
  score: number;
  /** Content tokens, for the diversity/near-dup penalty. */
  tokens: Set<string>;
}

/**
 * Greedy Maximal Marginal Relevance selection. Picks the highest-scored item,
 * then repeatedly the item maximizing `lambda*norm - (1-lambda)*maxSimToChosen`
 * where `norm` is the score normalized to [0,1] and `maxSimToChosen` is the
 * peak Jaccard to anything already selected. A near-duplicate has sim≈1, so its
 * marginal value collapses and it won't be picked while distinct items remain.
 *
 * lambda ∈ [0,1]: 1 = pure score (no diversity), 0 = pure diversity. Returns up
 * to `k` original items, in selection order.
 */
export function selectMMR<T>(candidates: MmrCandidate<T>[], k: number, lambda = 0.7): T[] {
  const pool = [...candidates];
  const chosen: MmrCandidate<T>[] = [];
  const maxScore = pool.reduce((m, c) => Math.max(m, c.score), 0) || 1;
  const lam = Math.min(1, Math.max(0, lambda));
  while (chosen.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const norm = pool[i].score / maxScore;
      let maxSim = 0;
      for (const c of chosen) {
        const sim = jaccard(pool[i].tokens, c.tokens);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lam * norm - (1 - lam) * maxSim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    chosen.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return chosen.map((c) => c.item);
}

/** Floor for the lexical multiplier: a zero-overlap record keeps this fraction
 *  of its composite score (so lexical relevance demotes, never zeroes). */
export const LEXICAL_SCORE_FLOOR = 0.3;
