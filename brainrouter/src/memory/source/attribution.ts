/**
 * MEM-15 (0.4.4) — exact chunk-level provenance.
 *
 * 0.4.3 linked every record in an extraction batch to EVERY source chunk of
 * the turn window (`capture.linkBatchProvenance`) — coarse and over-attributing,
 * so `memory_verify` / provenance could cite chunks a record never came from.
 * This attributes each distilled record to the source chunk(s) it actually
 * derives from, by salient-token overlap — the same lexical signal the recall
 * selection stage already uses. Pure + synchronous: no LLM, no network.
 */
import { tokenSet, lexicalOverlap } from "../reranker/lexical.js";

export interface AttributableChunk {
  id: string;
  content: string;
}

export interface ProvenanceConfig {
  /** Min fraction of a record's salient tokens a chunk must contain to be linked. */
  floor: number;
  /** Max chunks linked per record (best-first). */
  maxChunks: number;
}

/** Mirrors reranker LEXICAL_SCORE_FLOOR — a chunk sharing <30% of the record's
 * salient tokens is treated as not its source. */
const DEFAULT_FLOOR = 0.3;
const DEFAULT_MAX_CHUNKS = 3;

/**
 * Read MEM-15 knobs from the env (brain-side convention, like
 * BRAINROUTER_RECALL_DIVERSITY). Blank/invalid values fall back to defaults.
 *   BRAINROUTER_PROVENANCE_FLOOR       0..1  (default 0.3)
 *   BRAINROUTER_PROVENANCE_MAX_CHUNKS  >=1   (default 3)
 */
export function readProvenanceConfig(env: NodeJS.ProcessEnv = process.env): ProvenanceConfig {
  const rawFloor = Number.parseFloat(env.BRAINROUTER_PROVENANCE_FLOOR ?? "");
  const rawMax = Number.parseInt(env.BRAINROUTER_PROVENANCE_MAX_CHUNKS ?? "", 10);
  const floor = Number.isFinite(rawFloor) && rawFloor >= 0 && rawFloor <= 1 ? rawFloor : DEFAULT_FLOOR;
  const maxChunks = Number.isInteger(rawMax) && rawMax >= 1 ? rawMax : DEFAULT_MAX_CHUNKS;
  return { floor, maxChunks };
}

/**
 * Attribute one record to the chunk(s) it most likely came from.
 *
 * Scores every candidate chunk by lexicalOverlap(recordTokens, chunkTokens) —
 * the fraction of the record's salient tokens present in the chunk — then
 * returns, best-first:
 *   - all chunks scoring >= floor (capped at maxChunks), else
 *   - the single best chunk if it has ANY overlap (> 0), else
 *   - [] when the record shares no salient token with any chunk (genuinely
 *     unattributable — better than linking to unrelated sources).
 *
 * Deterministic: ties broken by the chunk's input order (stable).
 */
export function attributeRecordToChunks(
  recordContent: string,
  chunks: AttributableChunk[],
  config: ProvenanceConfig = { floor: DEFAULT_FLOOR, maxChunks: DEFAULT_MAX_CHUNKS },
): string[] {
  if (chunks.length === 0) return [];
  const recordTokens = tokenSet(recordContent);
  if (recordTokens.size === 0) return [];

  const scored = chunks.map((c, i) => ({
    id: c.id,
    i,
    score: lexicalOverlap(recordTokens, tokenSet(c.content)),
  }));
  // Score desc, then input order asc — deterministic.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const above = scored.filter((s) => s.score >= config.floor);
  if (above.length > 0) {
    return above.slice(0, config.maxChunks).map((s) => s.id);
  }
  // Fallback: best single chunk, but only if it shares any salient token.
  const best = scored[0];
  return best && best.score > 0 ? [best.id] : [];
}
