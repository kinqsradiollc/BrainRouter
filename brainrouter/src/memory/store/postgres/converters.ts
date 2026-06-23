/**
 * ADR-007 Phase 2 — Postgres row helpers + SQL translation utilities.
 *
 * The PURE `*RowToRecord` + `parseJson*` converters below are dependency-free
 * (no `this`, no DB handle) and map raw rows into the typed
 * `@kinqs/brainrouter-types` records. A `pg` result row is keyed by the same
 * column names (`record_id`, `user_id`, `metadata_json`, …) the schema uses, so
 * these mappers are the single source for the pg store. (Step 3 of the SQLite
 * removal inlined them here — they previously lived alongside the now-deleted
 * SQLite store.)
 *
 * The FTS helpers are storage-specific: Postgres uses `plainto_tsquery` +
 * `ts_rank`, so the pg store ships its own `ftsHasTerms` predicate and a
 * `tsRankToScore` normalizer (below) rather than any BM25-based helper.
 */

import type {
  ActiveSessionRecord,
  ActiveSessionUsage,
  CognitiveRecord,
  MemoryEvidence,
  MemoryJobRecord,
  MemoryJobStatus,
  MemoryOperation,
  SessionInboxKind,
  SessionInboxRecord,
} from "@kinqs/brainrouter-types";

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function cognitiveRowToRecord(row: any): CognitiveRecord {
  return {
    id: row.record_id,
    userId: row.user_id,
    sessionKey: row.session_key ?? "",
    sessionId: row.session_id ?? "",
    content: row.content,
    type: row.type || "episodic",
    priority: row.priority ?? 50,
    sceneName: row.scene_name ?? "",
    skillTag: row.skill_tag ?? "",
    halfLifeDays: row.half_life_days ?? null,
    supersededBy: row.superseded_by ?? null,
    invalidAt: row.invalid_at ?? null,
    timestampStr: row.timestamp_str ?? "",
    timestampStart: row.timestamp_start ?? "",
    timestampEnd: row.timestamp_end ?? "",
    createdTime: row.created_time ?? "",
    updatedTime: row.updated_time ?? "",
    metadata: parseJsonObject(row.metadata_json),
    confidence: typeof row.confidence === "number" ? row.confidence : 0.65,
    status: row.status ?? (row.archived ? "archived" : "active"),
    sourceKind: row.source_kind ?? "",
    verificationStatus: row.verification_status ?? "",
    repoPaths: parseJsonArray(row.repo_paths_json),
    filePaths: parseJsonArray(row.file_paths_json),
    commands: parseJsonArray(row.commands_json),
    citationCount: row.citation_count ?? 0,
    lastCitedAt: row.last_cited_at ?? null,
    neverCitedCount: row.never_cited_count ?? 0,
    archived: Boolean(row.archived),
    workspaceTag: row.workspace_tag ?? null,
    projectTag: row.project_tag ?? null,
  };
}

export function evidenceRowToRecord(row: any): MemoryEvidence {
  return {
    id: row.id,
    userId: row.user_id,
    recordId: row.record_id,
    kind: row.kind,
    ref: row.ref,
    excerpt: row.excerpt ?? "",
    observedAt: row.observed_at ?? "",
    metadata: parseJsonObject(row.metadata_json),
  };
}

export function activeSessionRowToRecord(row: any, includeUsage: boolean): ActiveSessionRecord {
  let usage: ActiveSessionUsage | null | undefined;
  if (includeUsage && row.usage_json) {
    try {
      usage = JSON.parse(row.usage_json);
    } catch {
      usage = null;
    }
  } else if (!includeUsage) {
    usage = undefined;
  } else {
    usage = null;
  }
  return {
    sessionKey: row.session_key,
    userId: row.user_id,
    clientKind: row.client_kind ?? "http-unknown",
    workspaceRoot: row.workspace_root ?? "",
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    metadata: parseJsonObject(row.metadata_json),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function inboxRowToRecord(row: {
  id: string;
  user_id: string;
  from_session_key: string;
  to_session_key: string;
  kind: string;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
}): SessionInboxRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    fromSessionKey: row.from_session_key,
    toSessionKey: row.to_session_key,
    kind: row.kind as SessionInboxKind,
    payload,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function jobRowToRecord(row: {
  id: string;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  parent_job_id: string | null;
  input_json: string;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}): MemoryJobRecord {
  const parse = (raw: string | null): unknown => {
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as MemoryJobStatus,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    lockedAt: row.locked_at,
    parentJobId: row.parent_job_id,
    input: parse(row.input_json),
    output: parse(row.output_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function operationRowToRecord(row: any): MemoryOperation {
  return {
    id: row.id,
    userId: row.user_id,
    recordId: row.record_id ?? null,
    operation: row.operation,
    actor: row.actor ?? "",
    sessionKey: row.session_key ?? "",
    reason: row.reason ?? "",
    createdAt: row.created_at ?? "",
    metadata: parseJsonObject(row.metadata_json),
  };
}

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
 * Build an OR-combined `to_tsquery` body from a free-text bag of terms, e.g.
 * `"parseConfig parse config"` → `"parseConfig | parse | config"`.
 *
 * Code search (`searchSourceChunksFts`) seeds the query from a chunk's
 * identifiers, where ANY shared token is a useful neighbour signal. The SQLite
 * FTS5 path matched that bag with OR semantics; `plainto_tsquery` would AND the
 * terms (requiring all), so a camelCase seed like `parseConfig` — stored as the
 * single lexeme `parseconfig` — never matched a split `parse & config` query.
 * Tokens are restricted to `[\p{L}\p{N}_]` (same set as `ftsHasTerms`), so the
 * joined string carries no `tsquery` operators and is safe to hand to
 * `to_tsquery`. Returns `""` when the input has no indexable token.
 */
export function orTsQuery(raw: string): string {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return "";
  return [...new Set(terms)].join(" | ");
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

// ── Compression cache (CCR) types ──────────────────────────────────────────
// Shared, storage-agnostic shapes for the compression-cache round-trip. The pg
// CCR implementation lives inline in PostgresMemoryStore; these types moved here
// (from the now-deleted SQLite compression store) so the pg store has a single
// import surface.

export interface CompressionEntryInput {
  userId: string;
  originalContent: string;
  compressedContent?: string | null;
  originalTokens?: number | null;
  compressedTokens?: number | null;
  originalItemCount?: number | null;
  compressedItemCount?: number | null;
  toolName?: string | null;
  queryContext?: string | null;
  compressionStrategy?: string | null;
  hash?: string;
}

export interface CompressionEntryMetadata {
  hash: string;
  userId: string;
  compressedContent: string | null;
  originalTokens: number | null;
  compressedTokens: number | null;
  originalItemCount: number | null;
  compressedItemCount: number | null;
  toolName: string | null;
  queryContext: string | null;
  compressionStrategy: string | null;
  createdAt: number;
  ttlSeconds: number;
  retrievalCount: number;
  lastAccessed: number | null;
}

export interface CompressionRetrieval {
  kind: "full" | "subset";
  entry: CompressionEntryMetadata;
  originalContent?: string;
  results?: unknown[];
}

export interface CompressionStats {
  compressions: number;
  retrievals: number;
  totalTokensSaved: number;
  savingsPercent: number;
  estimatedCostSavedUsd: number;
  recentEvents: Array<{
    hash: string;
    createdAt: number;
    originalTokens: number | null;
    compressedTokens: number | null;
    retrievalCount: number;
    compressionStrategy: string | null;
  }>;
  store: { entries: number; maxEntries: number };
}
