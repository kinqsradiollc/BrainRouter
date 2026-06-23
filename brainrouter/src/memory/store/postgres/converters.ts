/**
 * ADR-007 Phase 2 — Postgres row helpers + SQL translation utilities.
 *
 * The PURE `*RowToRecord` + `parseJson*` converters are shared verbatim with the
 * SQLite store: a `pg` result row is keyed by the same column names
 * (`record_id`, `user_id`, `metadata_json`, …) as a `node:sqlite` row, so the
 * exact same mappers apply. We re-export them here so the pg store imports from
 * one place.
 *
 * The FTS helpers, however, are storage-specific: SQLite uses FTS5 `MATCH` +
 * BM25 `rank`; Postgres uses `plainto_tsquery` + `ts_rank`. So `bm25RankToScore`
 * / `buildFtsQuery` are NOT reused — pg gets its own `ftsHasTerms` predicate and
 * a `tsRankToScore` normalizer instead.
 */

export {
  parseJsonObject,
  parseJsonArray,
  cognitiveRowToRecord,
  evidenceRowToRecord,
  activeSessionRowToRecord,
  inboxRowToRecord,
  jobRowToRecord,
  operationRowToRecord,
} from "../sqlite/converters.js";

/**
 * Format a Float32Array as a pgvector text literal: `[v1,v2,...]`. pgvector
 * accepts this for both inserts (`$1::vector`) and similarity probes.
 * `Number` keeps it finite-safe; pgvector rejects NaN/Inf, which never occur in
 * a real embedding.
 */
export function toVectorLiteral(embedding: Float32Array | number[]): string {
  return `[${Array.from(embedding, (v) => Number(v)).join(",")}]`;
}

/**
 * True when a free-text query has at least one indexable token. `plainto_tsquery`
 * returns an empty query for punctuation-only / stopword-only input, which would
 * match nothing — callers short-circuit to `[]` in that case, mirroring the
 * SQLite store's `buildFtsQuery(...) === null` guard.
 */
export function ftsHasTerms(raw: string): boolean {
  return (raw.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) > 0;
}

/**
 * Normalize a Postgres `ts_rank` (>= 0, higher = better) into the 0–1 band the
 * recall pipeline expects from `CognitiveFtsResult.score`. The SQLite path maps
 * FTS5's negative BM25 rank via `relevance/(1+relevance)`; we apply the same
 * saturating curve to `ts_rank` so downstream score fusion stays in range and
 * monotonic. (Exact cross-engine score equality isn't a contract — both are
 * relevance-monotonic 0–1 signals.)
 */
export function tsRankToScore(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return rank / (1 + rank);
}

/** Coerce a pg cell that may arrive as a string (bigint/numeric) into a number. */
export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === "bigint") return Number(value);
  return fallback;
}

/**
 * Translate a `?`-placeholder SQL string (SQLite/MySQL style) into Postgres
 * `$1..$n` positional parameters, left-to-right. Used so the dynamic
 * filter-building methods can keep the SQLite-shaped `?` strings and convert at
 * the call boundary. Does not touch `?` inside string literals — none of our
 * queries embed literal `?`, so a plain sequential replace is safe and keeps the
 * call sites readable.
 */
export function pg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
