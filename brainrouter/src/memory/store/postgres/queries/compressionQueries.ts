/**
 * Compression-cache (CCR) SQL + helpers — verbatim extraction from
 * `PostgresMemoryStore`.
 *
 * The CCR methods lean on the store's config (`ccrTtlSeconds`/`ccrMaxEntries`/
 * `ccrClock`) and its mutable `ccrLastPurgeAt` purge cursor. That state is
 * threaded through a `CcrContext` (config + get/set for the cursor) so timing
 * behaviour is identical to the inline version. The constants and the pure
 * hash/scoring helpers moved here alongside their only callers.
 */

import { createHash } from "node:crypto";
import type {
  CompressionEntryInput,
  CompressionEntryMetadata,
  CompressionRetrieval,
  CompressionStats,
} from "../converters.js";
import { asNumber } from "../converters.js";
import type { Executor } from "./executor.js";

// CCR knobs (mirrors SqliteCompressionStore defaults; ported because the pg CCR
// implementation lives inline rather than in a shared class).
export const HASH_PATTERN = /^[a-f0-9]{24}$/;
export const DEFAULT_TTL_SECONDS = 1_800;
export const DEFAULT_MAX_ENTRIES = 1_000;
const PURGE_INTERVAL_SECONDS = 60;
const QUERY_RESULT_LIMIT = 20;
const ESTIMATED_USD_PER_MILLION_TOKENS = 3;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}
function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("Compression hashes must contain exactly 24 lowercase hexadecimal characters.");
  }
}
function ccrQueryTerms(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}
function ccrItemScore(item: unknown, terms: Set<string>): number {
  const itemTerms = new Set(JSON.stringify(item).toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let score = 0;
  for (const term of terms) if (itemTerms.has(term)) score += 1;
  return score;
}

/** Store-owned CCR config + purge-cursor access, threaded to the helpers. */
export interface CcrContext {
  readonly ccrTtlSeconds: number;
  readonly ccrMaxEntries: number;
  ccrClock(): number;
  getCcrLastPurgeAt(): number;
  setCcrLastPurgeAt(value: number): void;
}

function ccrToMetadata(row: any): CompressionEntryMetadata {
  return {
    hash: row.hash,
    userId: row.user_id,
    compressedContent: row.compressed_content,
    originalTokens: row.original_tokens == null ? null : asNumber(row.original_tokens),
    compressedTokens: row.compressed_tokens == null ? null : asNumber(row.compressed_tokens),
    originalItemCount: row.original_item_count == null ? null : asNumber(row.original_item_count),
    compressedItemCount: row.compressed_item_count == null ? null : asNumber(row.compressed_item_count),
    toolName: row.tool_name,
    queryContext: row.query_context,
    compressionStrategy: row.compression_strategy,
    createdAt: asNumber(row.created_at),
    ttlSeconds: asNumber(row.ttl),
    retrievalCount: asNumber(row.retrieval_count),
    lastAccessed: row.last_accessed == null ? null : asNumber(row.last_accessed),
  };
}

async function ccrPurgeExpired(exec: Executor, ctx: CcrContext, now: number): Promise<void> {
  if (now - ctx.getCcrLastPurgeAt() < PURGE_INTERVAL_SECONDS) return;
  await exec.run("DELETE FROM ccr_entries WHERE created_at + ttl <= $1", [now]);
  ctx.setCcrLastPurgeAt(now);
}

async function ccrGetRow(exec: Executor, userId: string, hash: string): Promise<any | null> {
  return exec.one(
    `SELECT hash, user_id, original_content, compressed_content, original_tokens, compressed_tokens,
            original_item_count, compressed_item_count, tool_name, query_context, compression_strategy,
            created_at, ttl, retrieval_count, last_accessed
       FROM ccr_entries WHERE hash = $1 AND user_id = $2`,
    [hash, userId],
  );
}

export async function storeCompressionEntry(exec: Executor, ctx: CcrContext, input: CompressionEntryInput): Promise<CompressionEntryMetadata> {
  const now = ctx.ccrClock();
  await ccrPurgeExpired(exec, ctx, now);
  const computedHash = hashContent(input.originalContent);
  const hash = input.hash ?? computedHash;
  assertHash(hash);
  if (hash !== computedHash) throw new Error("Compression hash does not match the original content.");

  const existing = await ccrGetRow(exec, input.userId, hash);
  if (existing) return ccrToMetadata(existing);

  await exec.run(
    `INSERT INTO ccr_entries (
       hash, user_id, original_content, compressed_content, original_tokens, compressed_tokens,
       original_item_count, compressed_item_count, tool_name, query_context, compression_strategy,
       created_at, ttl, retrieval_count, last_accessed
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,NULL)`,
    [
      hash, input.userId, input.originalContent, input.compressedContent ?? null,
      input.originalTokens ?? null, input.compressedTokens ?? null,
      input.originalItemCount ?? null, input.compressedItemCount ?? null,
      input.toolName ?? null, input.queryContext ?? null, input.compressionStrategy ?? null,
      now, ctx.ccrTtlSeconds,
    ],
  );
  await ccrEvictOverflow(exec, ctx);
  return (await getCompressionEntryMetadata(exec, input.userId, hash))!;
}

async function ccrEvictOverflow(exec: Executor, ctx: CcrContext): Promise<void> {
  const row = await exec.one<{ count: string }>("SELECT COUNT(*) AS count FROM ccr_entries");
  const overflow = asNumber(row?.count) - ctx.ccrMaxEntries;
  if (overflow <= 0) return;
  // ctid identifies exactly one physical row (pg analogue of SQLite rowid),
  // so eviction can't drop another tenant's still-fresh row that shares a hash.
  await exec.run(
    `DELETE FROM ccr_entries
      WHERE ctid IN (SELECT ctid FROM ccr_entries ORDER BY created_at ASC, ctid ASC LIMIT $1)`,
    [overflow],
  );
}

export async function retrieveCompressionEntry(exec: Executor, ctx: CcrContext, userId: string, hash: string, query?: string): Promise<CompressionRetrieval | null> {
  if (!HASH_PATTERN.test(hash)) return null;
  const now = ctx.ccrClock();
  const row = await ccrGetRow(exec, userId, hash);
  if (!row) return null;
  if (asNumber(row.created_at) + asNumber(row.ttl) <= now) {
    await exec.run("DELETE FROM ccr_entries WHERE hash = $1 AND user_id = $2", [hash, userId]);
    return null;
  }
  const retrievalCount = asNumber(row.retrieval_count) + 1;
  await exec.run("UPDATE ccr_entries SET retrieval_count = $1, last_accessed = $2 WHERE hash = $3 AND user_id = $4", [retrievalCount, now, hash, userId]);
  const entry = ccrToMetadata({ ...row, retrieval_count: retrievalCount, last_accessed: now });
  const results = query ? ccrSelectQueryResults(row.original_content, query) : null;
  if (results) return { kind: "subset", entry, results };
  return { kind: "full", entry, originalContent: row.original_content };
}

export async function getCompressionEntryMetadata(exec: Executor, userId: string, hash: string): Promise<CompressionEntryMetadata | null> {
  if (!HASH_PATTERN.test(hash)) return null;
  const row = await ccrGetRow(exec, userId, hash);
  return row ? ccrToMetadata(row) : null;
}

export async function getCompressionStats(exec: Executor, ctx: CcrContext, userId: string): Promise<CompressionStats> {
  await ccrPurgeExpired(exec, ctx, ctx.ccrClock());
  const aggregate = await exec.one<any>(
    `SELECT COUNT(*) AS compressions,
            COALESCE(SUM(retrieval_count), 0) AS retrievals,
            COALESCE(SUM(original_tokens), 0) AS original_tokens,
            COALESCE(SUM(compressed_tokens), 0) AS compressed_tokens
       FROM ccr_entries WHERE user_id = $1`,
    [userId],
  );
  const recentEvents = await exec.rows<any>(
    `SELECT hash, created_at, original_tokens, compressed_tokens, retrieval_count, compression_strategy
       FROM ccr_entries WHERE user_id = $1 ORDER BY created_at DESC, hash DESC LIMIT 10`,
    [userId],
  );
  const originalTokens = asNumber(aggregate?.original_tokens);
  const compressedTokens = asNumber(aggregate?.compressed_tokens);
  const totalTokensSaved = Math.max(0, originalTokens - compressedTokens);
  return {
    compressions: asNumber(aggregate?.compressions),
    retrievals: asNumber(aggregate?.retrievals),
    totalTokensSaved,
    savingsPercent: originalTokens === 0 ? 0 : Math.round((totalTokensSaved / originalTokens) * 100),
    estimatedCostSavedUsd: Number(((totalTokensSaved / 1_000_000) * ESTIMATED_USD_PER_MILLION_TOKENS).toFixed(6)),
    recentEvents: recentEvents.map((event) => ({
      hash: event.hash,
      createdAt: asNumber(event.created_at),
      originalTokens: event.original_tokens == null ? null : asNumber(event.original_tokens),
      compressedTokens: event.compressed_tokens == null ? null : asNumber(event.compressed_tokens),
      retrievalCount: asNumber(event.retrieval_count),
      compressionStrategy: event.compression_strategy,
    })),
    store: { entries: asNumber(aggregate?.compressions), maxEntries: ctx.ccrMaxEntries },
  };
}

function ccrSelectQueryResults(originalContent: string, query: string): unknown[] | null {
  const terms = ccrQueryTerms(query);
  if (terms.size === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalContent);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .map((item, index) => ({ item, index, score: ccrItemScore(item, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, QUERY_RESULT_LIMIT)
    .map(({ item }) => item);
}
