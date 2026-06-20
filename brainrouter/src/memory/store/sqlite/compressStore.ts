import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HASH_PATTERN = /^[a-f0-9]{24}$/;
const DEFAULT_TTL_SECONDS = 1_800;
const DEFAULT_MAX_ENTRIES = 1_000;
const PURGE_INTERVAL_SECONDS = 60;
const QUERY_RESULT_LIMIT = 20;
// Rough blended input-token price used only to turn token savings into a
// human-friendly dollar figure for memory_stats. Deliberately a single rounded
// estimate, not a per-model price table — the value is labeled "estimated".
const ESTIMATED_USD_PER_MILLION_TOKENS = 3;

export interface SqliteCompressionStoreOptions {
  ttlSeconds?: number;
  maxEntries?: number;
  now?: () => number;
}

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

interface CompressionEntryRow {
  hash: string;
  user_id: string;
  original_content: string;
  compressed_content: string | null;
  original_tokens: number | null;
  compressed_tokens: number | null;
  original_item_count: number | null;
  compressed_item_count: number | null;
  tool_name: string | null;
  query_context: string | null;
  compression_strategy: string | null;
  created_at: number;
  ttl: number;
  retrieval_count: number;
  last_accessed: number | null;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("Compression hashes must contain exactly 24 lowercase hexadecimal characters.");
  }
}

function queryTerms(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

function itemScore(item: unknown, terms: Set<string>): number {
  const itemTerms = new Set(JSON.stringify(item).toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let score = 0;
  for (const term of terms) {
    if (itemTerms.has(term)) score += 1;
  }
  return score;
}

export class SqliteCompressionStore {
  private readonly ttlSeconds: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private lastPurgeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: DatabaseSync,
    options?: SqliteCompressionStoreOptions,
  ) {
    this.ttlSeconds = options?.ttlSeconds ?? readPositiveInteger(process.env.BRAINROUTER_CCR_TTL_SECONDS, DEFAULT_TTL_SECONDS);
    this.maxEntries = options?.maxEntries ?? readPositiveInteger(process.env.BRAINROUTER_CCR_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
    this.clock = options?.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  public initSchema(): void {
    // The natural key is (hash, user_id), NOT hash alone: the hash is the
    // sha256 of the content, so two tenants compressing identical content
    // produce the SAME hash. A bare `hash PRIMARY KEY` makes the second
    // tenant's INSERT collide ("UNIQUE constraint failed") in the shared
    // multi-tenant DB. A composite primary key gives each tenant its own row
    // while every read still scopes by (hash, user_id).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ccr_entries (
        hash TEXT NOT NULL,
        user_id TEXT NOT NULL,
        original_content TEXT NOT NULL,
        compressed_content TEXT,
        original_tokens INTEGER,
        compressed_tokens INTEGER,
        original_item_count INTEGER,
        compressed_item_count INTEGER,
        tool_name TEXT,
        query_context TEXT,
        compression_strategy TEXT,
        created_at REAL NOT NULL,
        ttl INTEGER NOT NULL,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_accessed REAL,
        PRIMARY KEY (hash, user_id)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_expiry ON ccr_entries(created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ccr_user ON ccr_entries(user_id)");
  }

  public store(input: CompressionEntryInput): CompressionEntryMetadata {
    const now = this.clock();
    this.purgeExpired(now);

    const computedHash = hashContent(input.originalContent);
    const hash = input.hash ?? computedHash;
    assertHash(hash);
    if (hash !== computedHash) {
      throw new Error("Compression hash does not match the original content.");
    }

    const existing = this.getRow(input.userId, hash);
    if (existing) return this.toMetadata(existing);

    this.db
      .prepare(
        `INSERT INTO ccr_entries (
          hash, user_id, original_content, compressed_content, original_tokens, compressed_tokens,
          original_item_count, compressed_item_count, tool_name, query_context, compression_strategy,
          created_at, ttl, retrieval_count, last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(
        hash,
        input.userId,
        input.originalContent,
        input.compressedContent ?? null,
        input.originalTokens ?? null,
        input.compressedTokens ?? null,
        input.originalItemCount ?? null,
        input.compressedItemCount ?? null,
        input.toolName ?? null,
        input.queryContext ?? null,
        input.compressionStrategy ?? null,
        now,
        this.ttlSeconds,
      );
    this.evictOverflow();

    return this.getCompressionEntryMetadata(input.userId, hash)!;
  }

  public retrieve(userId: string, hash: string, query?: string): CompressionRetrieval | null {
    if (!HASH_PATTERN.test(hash)) return null;
    const now = this.clock();
    const row = this.getRow(userId, hash);
    if (!row) return null;
    if (row.created_at + row.ttl <= now) {
      this.db.prepare("DELETE FROM ccr_entries WHERE hash = ? AND user_id = ?").run(hash, userId);
      return null;
    }

    const retrievalCount = row.retrieval_count + 1;
    this.db
      .prepare("UPDATE ccr_entries SET retrieval_count = ?, last_accessed = ? WHERE hash = ? AND user_id = ?")
      .run(retrievalCount, now, hash, userId);
    const entry = this.toMetadata({ ...row, retrieval_count: retrievalCount, last_accessed: now });
    const results = query ? this.selectQueryResults(row.original_content, query) : null;
    if (results) return { kind: "subset", entry, results };
    return { kind: "full", entry, originalContent: row.original_content };
  }

  public getCompressionEntryMetadata(userId: string, hash: string): CompressionEntryMetadata | null {
    if (!HASH_PATTERN.test(hash)) return null;
    const row = this.getRow(userId, hash);
    return row ? this.toMetadata(row) : null;
  }

  public getStats(userId: string): CompressionStats {
    this.purgeExpired(this.clock());
    const aggregate = this.db
      .prepare(
        `SELECT COUNT(*) AS compressions,
                COALESCE(SUM(retrieval_count), 0) AS retrievals,
                COALESCE(SUM(original_tokens), 0) AS original_tokens,
                COALESCE(SUM(compressed_tokens), 0) AS compressed_tokens
           FROM ccr_entries
          WHERE user_id = ?`,
      )
      .get(userId) as {
      compressions: number;
      retrievals: number;
      original_tokens: number;
      compressed_tokens: number;
    };
    const recentEvents = this.db
      .prepare(
        `SELECT hash, created_at, original_tokens, compressed_tokens, retrieval_count, compression_strategy
           FROM ccr_entries
          WHERE user_id = ?
          ORDER BY created_at DESC, hash DESC
          LIMIT 10`,
      )
      .all(userId) as Array<{
      hash: string;
      created_at: number;
      original_tokens: number | null;
      compressed_tokens: number | null;
      retrieval_count: number;
      compression_strategy: string | null;
    }>;
    const totalTokensSaved = Math.max(0, Number(aggregate.original_tokens) - Number(aggregate.compressed_tokens));
    return {
      compressions: Number(aggregate.compressions),
      retrievals: Number(aggregate.retrievals),
      totalTokensSaved,
      savingsPercent: Number(aggregate.original_tokens) === 0
        ? 0
        : Math.round((totalTokensSaved / Number(aggregate.original_tokens)) * 100),
      estimatedCostSavedUsd: Number(((totalTokensSaved / 1_000_000) * ESTIMATED_USD_PER_MILLION_TOKENS).toFixed(6)),
      recentEvents: recentEvents.map((event) => ({
        hash: event.hash,
        createdAt: event.created_at,
        originalTokens: event.original_tokens,
        compressedTokens: event.compressed_tokens,
        retrievalCount: event.retrieval_count,
        compressionStrategy: event.compression_strategy,
      })),
      store: { entries: Number(aggregate.compressions), maxEntries: this.maxEntries },
    };
  }

  private getRow(userId: string, hash: string): CompressionEntryRow | null {
    const row = this.db
      .prepare(
        `SELECT hash, user_id, original_content, compressed_content, original_tokens, compressed_tokens,
                original_item_count, compressed_item_count, tool_name, query_context, compression_strategy,
                created_at, ttl, retrieval_count, last_accessed
           FROM ccr_entries
          WHERE hash = ? AND user_id = ?`,
      )
      .get(hash, userId) as CompressionEntryRow | undefined;
    return row ?? null;
  }

  private toMetadata(row: CompressionEntryRow): CompressionEntryMetadata {
    return {
      hash: row.hash,
      userId: row.user_id,
      compressedContent: row.compressed_content,
      originalTokens: row.original_tokens,
      compressedTokens: row.compressed_tokens,
      originalItemCount: row.original_item_count,
      compressedItemCount: row.compressed_item_count,
      toolName: row.tool_name,
      queryContext: row.query_context,
      compressionStrategy: row.compression_strategy,
      createdAt: row.created_at,
      ttlSeconds: row.ttl,
      retrievalCount: row.retrieval_count,
      lastAccessed: row.last_accessed,
    };
  }

  private purgeExpired(now: number): void {
    if (now - this.lastPurgeAt < PURGE_INTERVAL_SECONDS) return;
    this.db.prepare("DELETE FROM ccr_entries WHERE created_at + ttl <= ?").run(now);
    this.lastPurgeAt = now;
  }

  private evictOverflow(): void {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM ccr_entries").get() as { count: number };
    const overflow = Number(row.count) - this.maxEntries;
    if (overflow <= 0) return;
    // Evict by rowid, not by hash: with the composite (hash, user_id) key two
    // tenants can share a hash, so `WHERE hash IN (...)` could evict another
    // tenant's still-fresh row. rowid identifies exactly one row.
    this.db
      .prepare(
        `DELETE FROM ccr_entries
          WHERE rowid IN (
            SELECT rowid FROM ccr_entries
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?
          )`,
      )
      .run(overflow);
  }

  private selectQueryResults(originalContent: string, query: string): unknown[] | null {
    const terms = queryTerms(query);
    if (terms.size === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(originalContent);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    return parsed
      .map((item, index) => ({ item, index, score: itemScore(item, terms) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, QUERY_RESULT_LIMIT)
      .map(({ item }) => item);
  }
}
