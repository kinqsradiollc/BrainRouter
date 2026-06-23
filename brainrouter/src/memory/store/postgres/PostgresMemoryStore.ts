/**
 * ADR-007 Phase 2 (step 2) — native-async Postgres + pgvector memory store.
 *
 * A faithful port of `SqliteMemoryStore` to `node-postgres`, implementing the
 * async `IMemoryStore` contract plus the full set of concrete capability methods
 * the engine reaches via `store as ...` casts (tree, blackboard, source,
 * compression, vault, lessons, graph extras). Behaviour mirrors the SQLite store
 * 1:1; the differences are purely the storage layer:
 *
 *   * FTS5 virtual tables → a generated `content_tsv tsvector` column + GIN
 *     index (created by migration 002). "FTS insert" is therefore a no-op here
 *     (the column is maintained by Postgres); FTS search uses
 *     `content_tsv @@ plainto_tsquery('english', $q)` ranked by `ts_rank`.
 *   * sqlite-vec `cognitive_vec` (vec0 virtual table) → a real
 *     `cognitive_vec(record_id, embedding vector(N))` table created at runtime in
 *     `initVec(N)` with a cosine ANN index; search uses the `<=>` operator.
 *   * `BEGIN IMMEDIATE` write-lock claims → a pooled client running
 *     `BEGIN`/`SELECT ... FOR UPDATE SKIP LOCKED`/`COMMIT` for the atomic
 *     job/delegation claim methods.
 *
 * The schema (001_init + 002_schema) is applied by `init()` via the migration
 * runner; `cognitive_vec` is deferred to `initVec` because its dimension is
 * embedder-dependent.
 */

import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ActiveSessionFilters,
  ActiveSessionRecord,
  ActiveSessionUsage,
  SessionInboxFilters,
  SessionInboxRecord,
  PendingDelegationRecord,
  PendingDelegationEnqueueInput,
  PendingDelegationFilters,
  PendingDelegationStatus,
  DelegationPacket,
  MemoryJobRecord,
  MemoryJobStatus,
  MemoryJobEnqueueInput,
  MemoryJobListFilters,
  MemoryJobKindAggregate,
  ContradictionRecord,
  CursorPaginationOptions,
  EvidenceListFilters,
  ExtractionStatus,
  ImportResult,
  SensoryRecord,
  CognitiveRecord,
  CognitiveFtsResult,
  MemoryEvidence,
  MemoryExport,
  MemoryImport,
  MemoryListFilters,
  MemoryListItem,
  MemoryOperation,
  MemoryStatus,
  OperationLogFilters,
  VectorSearchResult,
  SkillActivationRecord,
  SkillHintsRecord,
  ContextualFocusRecord,
  CoreIdentityRecord,
  SchedulerState,
  GraphNode,
  GraphEdge,
  StalledExtractionBacklog,
  UserRecord,
  SourceDocument,
  SourceChunk,
  SourceChunkInput,
  BlackboardItem,
  BlackboardItemInput,
  BlackboardStatus,
  MemoryTreeNode,
  MemoryTreeNodeInput,
  MemoryTreeKind,
  VaultExportEntry,
  VaultExportInput,
  AtlasGraph,
  AtlasWorkspaceSummary,
  IMemoryStore,
} from "@kinqs/brainrouter-types";
import { createPgPool } from "./connection.js";
import { loadMigrations, applyMigrations } from "./migrate.js";
import {
  parseJsonObject,
  cognitiveRowToRecord,
  evidenceRowToRecord,
  activeSessionRowToRecord,
  inboxRowToRecord,
  jobRowToRecord,
  operationRowToRecord,
  toVectorLiteral,
  ftsHasTerms,
  orTsQuery,
  tsRankToScore,
  asNumber,
  pg,
  type CompressionEntryInput,
  type CompressionEntryMetadata,
  type CompressionRetrieval,
  type CompressionStats,
} from "./converters.js";
import { extractIntraFileCallEdges } from "../../recall/code-retrieval.js";
import { expandImportRecord, readImportChunkChars } from "../../pipeline/chunk-import.js";
import { mapWithConcurrency, readEmbedConcurrency } from "../../util/concurrency.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

// CCR knobs (mirrors SqliteCompressionStore defaults; ported because the pg CCR
// implementation lives inline rather than in a shared class).
const HASH_PATTERN = /^[a-f0-9]{24}$/;
const DEFAULT_TTL_SECONDS = 1_800;
const DEFAULT_MAX_ENTRIES = 1_000;
const PURGE_INTERVAL_SECONDS = 60;
const QUERY_RESULT_LIMIT = 20;
const ESTIMATED_USD_PER_MILLION_TOKENS = 3;

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
function ccrQueryTerms(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}
function ccrItemScore(item: unknown, terms: Set<string>): number {
  const itemTerms = new Set(JSON.stringify(item).toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let score = 0;
  for (const term of terms) if (itemTerms.has(term)) score += 1;
  return score;
}

export interface PostgresMemoryStoreOptions {
  /** Pass an existing pool (e.g. a test harness on a scratch database). */
  pool?: Pool;
  compressionStore?: { ttlSeconds?: number; maxEntries?: number; now?: () => number };
}

export class PostgresMemoryStore implements IMemoryStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private vecReady = false;
  private vecDimensions = 0;

  // CCR config
  private readonly ccrTtlSeconds: number;
  private readonly ccrMaxEntries: number;
  private readonly ccrClock: () => number;
  private ccrLastPurgeAt = Number.NEGATIVE_INFINITY;

  constructor(connection: string | Pool, options?: PostgresMemoryStoreOptions) {
    if (options?.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (typeof connection === "string") {
      this.pool = createPgPool(connection);
      this.ownsPool = true;
    } else {
      this.pool = connection;
      this.ownsPool = false;
    }
    this.ccrTtlSeconds = options?.compressionStore?.ttlSeconds ?? readPositiveInteger(process.env.BRAINROUTER_CCR_TTL_SECONDS, DEFAULT_TTL_SECONDS);
    this.ccrMaxEntries = options?.compressionStore?.maxEntries ?? readPositiveInteger(process.env.BRAINROUTER_CCR_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
    this.ccrClock = options?.compressionStore?.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  // ── low-level query helpers ────────────────────────────────────────────

  /** Run a parameterized query and return the rows. `params` are positional ($1..). */
  private async rows<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  /** Run a query and return the first row, or null. */
  private async one<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<T | null> {
    const res = await this.pool.query<T>(text, params);
    return res.rows[0] ?? null;
  }

  /** Run a write and return rowCount (mirrors SQLite's `changes`). */
  private async run(text: string, params: any[] = []): Promise<number> {
    const res = await this.pool.query(text, params);
    return res.rowCount ?? 0;
  }

  /** Execute `fn` inside a single transaction on one pooled client. */
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  public async init(): Promise<void> {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await applyMigrations(this.pool, migrations);
  }

  public async initVec(dimensions: number): Promise<void> {
    if (dimensions <= 0) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id integer PRIMARY KEY CHECK (id = 1),
        dimensions integer NOT NULL,
        created_at text NOT NULL
      )
    `);

    // Detect an existing cognitive_vec and its dimension. pgvector stores the
    // declared dim in the column's atttypmod (typmod - 4 == dimensions for
    // `vector(N)`). Drop + recreate on a dimension change, mirroring the SQLite
    // store's vec0 recreate path.
    const dimRow = await this.one<{ dim: number | null }>(
      `SELECT (atttypmod - 4) AS dim
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'cognitive_vec' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    const existingDim = dimRow && dimRow.dim != null ? asNumber(dimRow.dim, -1) : -1;

    if (existingDim !== -1 && existingDim !== dimensions) {
      await this.pool.query("DROP TABLE IF EXISTS cognitive_vec");
      await this.run("UPDATE embedding_meta SET dimensions = $1, created_at = $2 WHERE id = 1", [dimensions, new Date().toISOString()]);
    } else {
      const meta = await this.one<{ dimensions: number }>("SELECT dimensions FROM embedding_meta WHERE id = 1");
      if (!meta) {
        await this.run("INSERT INTO embedding_meta (id, dimensions, created_at) VALUES (1, $1, $2)", [dimensions, new Date().toISOString()]);
      }
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS cognitive_vec (
         record_id text PRIMARY KEY,
         embedding vector(${dimensions})
       )`,
    );
    // Cosine ANN index. ivfflat needs a non-empty table to build well but is
    // valid empty; `IF NOT EXISTS` keeps it idempotent across boots.
    try {
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_cognitive_vec_cos
           ON cognitive_vec USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      );
    } catch {
      // Some pgvector builds prefer hnsw / reject ivfflat params; the table still
      // works with a sequential scan, so index creation is best-effort.
    }

    this.vecDimensions = dimensions;
    this.vecReady = true;
  }

  public isVecAvailable(): boolean {
    return this.vecReady && this.vecDimensions > 0;
  }

  public async reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number> {
    if (!this.vecReady) return 0;
    const rows = await this.rows<{ record_id: string; content: string }>(`
      SELECT r.record_id, r.content
      FROM cognitive_records r
      LEFT JOIN cognitive_vec v ON r.record_id = v.record_id
      WHERE r.invalid_at IS NULL AND r.archived = 0 AND v.record_id IS NULL
      ORDER BY r.created_time ASC, r.record_id ASC
    `);
    const outcomes = await mapWithConcurrency(rows, readEmbedConcurrency(), async (row) => {
      try {
        const embedding = await embedder(row.content);
        await this.upsertCognitiveVec(row.record_id, embedding);
        return true;
      } catch (error) {
        console.error(`[BrainRouter] Failed to re-embed record ${row.record_id}:`, error instanceof Error ? error.message : error);
        return false;
      }
    });
    return outcomes.reduce((acc, ok) => acc + (ok ? 1 : 0), 0);
  }

  public async getSqliteVersion(): Promise<string> {
    try {
      const row = await this.one<{ version: string }>("SELECT version() AS version");
      return row?.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Close the pool (only if this store created it). For test/teardown use. */
  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  // ── sensory ────────────────────────────────────────────────────────────

  public async upsertSensory(record: SensoryRecord): Promise<void> {
    await this.run(
      `INSERT INTO sensory_stream (record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (record_id) DO UPDATE SET
         message_text = EXCLUDED.message_text,
         recorded_at = EXCLUDED.recorded_at,
         timestamp = EXCLUDED.timestamp`,
      [record.id, record.userId, record.sessionKey, record.sessionId, record.role, record.messageText, record.recordedAt, record.timestamp, record.skillTag],
    );
  }

  public async getRecentSensoryMessages(userId: string, sessionKey: string, limit: number, afterIsoTime = ""): Promise<SensoryRecord[]> {
    const rows = await this.rows<any>(
      `SELECT record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag
         FROM sensory_stream
        WHERE user_id = $1 AND session_key = $2 AND recorded_at > $3 AND extracted_at IS NULL
        ORDER BY recorded_at DESC
        LIMIT $4`,
      [userId, sessionKey, afterIsoTime, limit],
    );
    // Reverse so chronologically oldest-first (matches SQLite store).
    return rows.reverse().map((r) => ({
      id: r.record_id,
      userId: r.user_id,
      sessionKey: r.session_key,
      sessionId: r.session_id,
      role: r.role,
      messageText: r.message_text,
      recordedAt: r.recorded_at,
      timestamp: asNumber(r.timestamp),
      skillTag: r.skill_tag,
    }));
  }

  public async getUnextractedSensoryCount(userId: string, sessionKey: string): Promise<number> {
    const row = await this.one<{ count: string }>(
      "SELECT COUNT(*) AS count FROM sensory_stream WHERE user_id = $1 AND session_key = $2 AND extracted_at IS NULL",
      [userId, sessionKey],
    );
    return asNumber(row?.count);
  }

  public async markSensoryExtracted(userId: string, sessionKey: string, recordIds: string[], extractedAt = new Date().toISOString()): Promise<void> {
    if (recordIds.length === 0) return;
    await this.run(
      "UPDATE sensory_stream SET extracted_at = $1 WHERE user_id = $2 AND session_key = $3 AND record_id = ANY($4::text[])",
      [extractedAt, userId, sessionKey, recordIds],
    );
  }

  // ── cognitive ──────────────────────────────────────────────────────────

  private cognitiveUpsertParams(record: CognitiveRecord): any[] {
    return [
      record.id, record.userId, record.sessionKey, record.sessionId, record.content,
      record.type, record.priority, record.sceneName, record.skillTag,
      record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
      record.timestampStart, record.timestampEnd, record.createdTime,
      record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
      record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
      JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
      JSON.stringify(record.commands ?? []), record.workspaceTag ?? null, record.projectTag ?? null,
    ];
  }

  private async upsertCognitiveMeta(client: PoolClient, record: CognitiveRecord): Promise<void> {
    await client.query(
      `INSERT INTO cognitive_records (
         record_id, user_id, session_key, session_id, content, type, priority, scene_name, skill_tag,
         half_life_days, superseded_by, invalid_at, timestamp_str, timestamp_start, timestamp_end,
         created_time, updated_time, metadata_json, confidence, status, source_kind, verification_status,
         repo_paths_json, file_paths_json, commands_json, workspace_tag, project_tag
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (record_id) DO UPDATE SET
         content=EXCLUDED.content,
         type=EXCLUDED.type,
         priority=EXCLUDED.priority,
         scene_name=EXCLUDED.scene_name,
         skill_tag=EXCLUDED.skill_tag,
         half_life_days=EXCLUDED.half_life_days,
         superseded_by=EXCLUDED.superseded_by,
         invalid_at=EXCLUDED.invalid_at,
         timestamp_str=EXCLUDED.timestamp_str,
         timestamp_start=EXCLUDED.timestamp_start,
         timestamp_end=EXCLUDED.timestamp_end,
         updated_time=EXCLUDED.updated_time,
         metadata_json=EXCLUDED.metadata_json,
         confidence=EXCLUDED.confidence,
         status=EXCLUDED.status,
         source_kind=EXCLUDED.source_kind,
         verification_status=EXCLUDED.verification_status,
         repo_paths_json=EXCLUDED.repo_paths_json,
         file_paths_json=EXCLUDED.file_paths_json,
         commands_json=EXCLUDED.commands_json,
         workspace_tag=COALESCE(EXCLUDED.workspace_tag, cognitive_records.workspace_tag),
         project_tag=COALESCE(EXCLUDED.project_tag, cognitive_records.project_tag)`,
      this.cognitiveUpsertParams(record),
    );
  }

  private async replaceFileIndexTx(client: PoolClient, record: CognitiveRecord): Promise<void> {
    await client.query("DELETE FROM memory_file_index WHERE user_id = $1 AND record_id = $2", [record.userId, record.id]);
    const filePaths = [...new Set((record.filePaths ?? []).map((fp) => fp.trim()).filter(Boolean))];
    for (const filePath of filePaths) {
      await client.query(
        "INSERT INTO memory_file_index (id, user_id, record_id, file_path, symbol, created_time) VALUES ($1,$2,$3,$4,'',$5)",
        [randomUUID(), record.userId, record.id, filePath, record.createdTime],
      );
    }
  }

  private async insertOperationTx(client: PoolClient, op: MemoryOperation): Promise<void> {
    await client.query(
      `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         operation=EXCLUDED.operation, actor=EXCLUDED.actor, session_key=EXCLUDED.session_key,
         reason=EXCLUDED.reason, metadata_json=EXCLUDED.metadata_json`,
      [op.id, op.userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
    );
  }

  public async upsertCognitiveBatch(entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>, options?: { skipAudit?: boolean }): Promise<void> {
    await this.tx(async (client) => {
      for (const entry of entries) {
        const record = entry.record;
        await this.upsertCognitiveMeta(client, record);
        // FTS column is generated — no FTS insert needed.
        if (entry.embedding && this.vecReady) {
          await client.query(
            `INSERT INTO cognitive_vec (record_id, embedding) VALUES ($1, $2::vector)
             ON CONFLICT (record_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
            [record.id, toVectorLiteral(entry.embedding)],
          );
        }
        await this.replaceFileIndexTx(client, record);
        if (!options?.skipAudit) {
          await this.insertOperationTx(client, {
            id: randomUUID(), userId: record.userId, recordId: record.id,
            operation: "cognitive_upsert", actor: "system", sessionKey: record.sessionKey,
            reason: "", createdAt: new Date().toISOString(), metadata: { batch: true, type: record.type },
          });
        }
      }
    });
  }

  public async upsertCognitive(record: CognitiveRecord, options?: { skipAudit?: boolean }): Promise<void> {
    await this.tx(async (client) => {
      await this.upsertCognitiveMeta(client, record);
      await this.replaceFileIndexTx(client, record);
      if (!options?.skipAudit) {
        await this.insertOperationTx(client, {
          id: randomUUID(), userId: record.userId, recordId: record.id,
          operation: "cognitive_upsert", actor: "system", sessionKey: record.sessionKey,
          reason: "", createdAt: new Date().toISOString(), metadata: { type: record.type },
        });
      }
    });
  }

  public async invalidateCognitiveRecord(userId: string, recordId: string, supersededById: string): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      "UPDATE cognitive_records SET invalid_at = $1, superseded_by = $2, status = 'superseded' WHERE user_id = $3 AND record_id = $4",
      [now, supersededById, userId, recordId],
    );
    await this.insertOperation({
      id: randomUUID(), userId, recordId, operation: "cognitive_supersede", actor: "system",
      sessionKey: "", reason: `Superseded by ${supersededById}`, createdAt: now, metadata: { supersededById },
    });
  }

  public async getMemoryById(userId: string, recordId: string): Promise<CognitiveRecord | null> {
    const row = await this.one("SELECT * FROM cognitive_records WHERE record_id = $1 AND user_id = $2", [recordId, userId]);
    return row ? cognitiveRowToRecord(row) : null;
  }

  public async getMemoriesByFilePath(userId: string, filePath: string, limit: number): Promise<CognitiveRecord[]> {
    const rows = await this.rows(
      `SELECT r.*
         FROM memory_file_index i
         JOIN cognitive_records r ON r.user_id = i.user_id AND r.record_id = i.record_id
        WHERE i.user_id = $1 AND (i.file_path = $2 OR i.file_path LIKE $3)
          AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY i.created_time DESC, r.priority DESC
        LIMIT $4`,
      [userId, filePath, `%${filePath}%`, limit],
    );
    return rows.map(cognitiveRowToRecord);
  }

  public async findLessonByFingerprint(userId: string, fingerprint: string): Promise<CognitiveRecord | null> {
    const row = await this.one(
      `SELECT r.* FROM cognitive_records r
        WHERE r.user_id = $1 AND r.type = 'lesson'
          AND r.metadata_json::jsonb ->> 'fingerprint' = $2
          AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY r.created_time DESC LIMIT 1`,
      [userId, fingerprint],
    );
    return row ? cognitiveRowToRecord(row) : null;
  }

  public async findLessonsByConflictKey(userId: string, conflictKey: string): Promise<CognitiveRecord[]> {
    const rows = await this.rows(
      `SELECT r.* FROM cognitive_records r
        WHERE r.user_id = $1 AND r.type = 'lesson'
          AND r.metadata_json::jsonb ->> 'conflictKey' = $2
          AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY r.created_time DESC LIMIT 50`,
      [userId, conflictKey],
    );
    return rows.map(cognitiveRowToRecord);
  }

  public async listLessonsForHygiene(userId: string, limit: number): Promise<CognitiveRecord[]> {
    const rows = await this.rows(
      `SELECT r.* FROM cognitive_records r
        WHERE r.user_id = $1 AND r.type = 'lesson'
          AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY r.created_time ASC LIMIT $2`,
      [userId, Math.max(1, limit)],
    );
    return rows.map(cognitiveRowToRecord);
  }

  public async updateCognitiveConfidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      "UPDATE cognitive_records SET confidence = $1, status = $2, archived = CASE WHEN $3 = 'archived' THEN 1 ELSE archived END, updated_time = $4 WHERE user_id = $5 AND record_id = $6",
      [confidence, status, status, now, userId, recordId],
    );
    await this.insertOperation({
      id: randomUUID(), userId, recordId, operation: "cognitive_status_update", actor: "system",
      sessionKey: "", reason: "", createdAt: now, metadata: { confidence, status },
    });
  }

  // ── evidence + operations ───────────────────────────────────────────────

  public async insertEvidence(ev: MemoryEvidence): Promise<void> {
    await this.run(
      `INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         kind=EXCLUDED.kind, ref=EXCLUDED.ref, excerpt=EXCLUDED.excerpt,
         observed_at=EXCLUDED.observed_at, metadata_json=EXCLUDED.metadata_json`,
      [ev.id, ev.userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {})],
    );
    await this.insertOperation({
      id: randomUUID(), userId: ev.userId, recordId: ev.recordId, operation: "evidence_add", actor: "system",
      sessionKey: "", reason: "", createdAt: new Date().toISOString(), metadata: { evidenceId: ev.id, kind: ev.kind, ref: ev.ref },
    });
  }

  public async getEvidenceByRecord(userId: string, recordId: string): Promise<MemoryEvidence[]> {
    const rows = await this.rows(
      `SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
         FROM memory_evidence WHERE user_id = $1 AND record_id = $2
        ORDER BY observed_at DESC, id ASC`,
      [userId, recordId],
    );
    return rows.map(evidenceRowToRecord);
  }

  public async listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>,
  ): Promise<MemoryEvidence[]> {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.recordId) { where.push("record_id = ?"); args.push(filters.recordId); }
    if (filters?.kind) { where.push("kind = ?"); args.push(filters.kind); }
    if (pagination?.cursor) {
      where.push("(observed_at < ? OR (observed_at = ? AND id > ?))");
      args.push(pagination.cursor.observedAt, pagination.cursor.observedAt, pagination.cursor.id);
    }
    args.push(pagination?.limit ?? 100);
    const rows = await this.rows(
      pg(`SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
            FROM memory_evidence WHERE ${where.join(" AND ")}
           ORDER BY observed_at DESC, id ASC LIMIT ?`),
      args,
    );
    return rows.map(evidenceRowToRecord);
  }

  public async insertOperation(op: MemoryOperation): Promise<void> {
    await this.run(
      `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         operation=EXCLUDED.operation, actor=EXCLUDED.actor, session_key=EXCLUDED.session_key,
         reason=EXCLUDED.reason, metadata_json=EXCLUDED.metadata_json`,
      [op.id, op.userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
    );
  }

  public async getOperationLog(
    userId: string,
    options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters,
  ): Promise<MemoryOperation[]> {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.operation) { where.push("operation = ?"); args.push(filters.operation); }
    if (filters?.sessionKey) { where.push("session_key = ?"); args.push(filters.sessionKey); }
    if (filters?.createdAfter) { where.push("created_at >= ?"); args.push(filters.createdAfter); }
    if (filters?.createdBefore) { where.push("created_at <= ?"); args.push(filters.createdBefore); }
    if (options?.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id > ?))");
      args.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    }
    args.push(options?.limit ?? 100);
    const rows = await this.rows(
      pg(`SELECT id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json
            FROM memory_operations WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, id ASC LIMIT ?`),
      args,
    );
    return rows.map(operationRowToRecord);
  }

  public async exportMemories(userId: string): Promise<MemoryExport> {
    const memoryRows = await this.rows("SELECT * FROM cognitive_records WHERE user_id = $1 ORDER BY created_time ASC, record_id ASC", [userId]);
    const evidenceRows = await this.rows("SELECT * FROM memory_evidence WHERE user_id = $1 ORDER BY observed_at ASC, id ASC", [userId]);
    const operationRows = await this.rows("SELECT * FROM memory_operations WHERE user_id = $1 ORDER BY created_at ASC, id ASC", [userId]);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      userId,
      memories: memoryRows.map(cognitiveRowToRecord),
      evidence: evidenceRows.map(evidenceRowToRecord),
      operations: operationRows.map(operationRowToRecord),
    };
  }

  public async importMemories(userId: string, data: MemoryImport): Promise<ImportResult> {
    let importedMemories = 0;
    let importedEvidence = 0;
    let importedOperations = 0;
    await this.tx(async (client) => {
      const chunkChars = readImportChunkChars();
      const memories = (data.memories ?? []).flatMap((r) => expandImportRecord(r, chunkChars));
      for (const record of memories) {
        await this.upsertCognitiveMeta(client, { ...record, userId });
        await this.replaceFileIndexTx(client, { ...record, userId });
        importedMemories++;
      }
      for (const ev of data.evidence ?? []) {
        await client.query(
          `INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             kind=EXCLUDED.kind, ref=EXCLUDED.ref, excerpt=EXCLUDED.excerpt,
             observed_at=EXCLUDED.observed_at, metadata_json=EXCLUDED.metadata_json`,
          [ev.id, userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {})],
        );
        importedEvidence++;
      }
      for (const op of data.operations ?? []) {
        await client.query(
          `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [op.id, userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
        );
        importedOperations++;
      }
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
         VALUES ($1,$2,NULL,'import','system','','',$3,$4)`,
        [randomUUID(), userId, now, JSON.stringify({ importedMemories, importedEvidence, importedOperations })],
      );
    });
    return { importedMemories, importedEvidence, importedOperations };
  }

  public async hardDeleteMemory(userId: string, recordId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.tx(async (client) => {
      await client.query("DELETE FROM memory_evidence WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
      await client.query("DELETE FROM memory_file_index WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
      // cognitive_vec has no user_id column (record-id keyed); delete by id.
      await client.query("DELETE FROM cognitive_vec WHERE record_id = $1", [recordId]).catch(() => undefined);
      await client.query("DELETE FROM cognitive_records WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
      await client.query(
        `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
         VALUES ($1,$2,$3,'governance_delete','system','',$4,$5,'{}')`,
        [randomUUID(), userId, recordId, reason, now],
      );
    });
  }

  // ── FTS (tsvector + GIN) ──────────────────────────────────────────────

  public async searchCognitiveFts(userId: string, query: string, limit: number): Promise<CognitiveFtsResult[]> {
    if (!ftsHasTerms(query)) return [];
    const rows = await this.rows<any>(
      `SELECT r.record_id, r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
              r.session_key, r.timestamp_str, r.created_time, r.citation_count,
              ts_rank(r.content_tsv, plainto_tsquery('english', $2)) AS rank
         FROM cognitive_records r
        WHERE r.user_id = $1 AND r.content_tsv @@ plainto_tsquery('english', $2)
          AND r.invalid_at IS NULL AND r.archived = 0
        ORDER BY rank DESC
        LIMIT $3`,
      [userId, query, limit],
    );
    return rows.map((r) => ({
      record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
      priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
      score: tsRankToScore(asNumber(r.rank)), timestamp_str: r.timestamp_str,
      timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
      metadata_json: "{}", created_time: r.created_time, citation_count: asNumber(r.citation_count),
    }));
  }

  public async searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string): Promise<CognitiveFtsResult[]> {
    if (!ftsHasTerms(query)) return [];
    const rows = await this.rows<any>(
      `SELECT r.record_id, r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
              r.session_key, r.timestamp_str, r.created_time,
              ts_rank(r.content_tsv, plainto_tsquery('english', $2)) AS rank
         FROM cognitive_records r
        WHERE r.user_id = $1 AND r.content_tsv @@ plainto_tsquery('english', $2)
          AND r.created_time <= $3
          AND (r.invalid_at IS NULL OR r.invalid_at > $3)
          AND r.archived = 0
        ORDER BY rank DESC
        LIMIT $4`,
      [userId, query, asOf, limit],
    );
    return rows.map((r) => ({
      record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
      priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
      score: tsRankToScore(asNumber(r.rank)), timestamp_str: r.timestamp_str,
      timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
      metadata_json: "{}", created_time: r.created_time,
    }));
  }

  // ── vector (pgvector) ────────────────────────────────────────────────

  public async upsertCognitiveVec(recordId: string, embedding: Float32Array): Promise<void> {
    if (!this.vecReady) return;
    if (this.vecDimensions !== embedding.length) {
      await this.initVec(embedding.length);
    }
    if (!this.vecReady) return;
    await this.run(
      `INSERT INTO cognitive_vec (record_id, embedding) VALUES ($1, $2::vector)
       ON CONFLICT (record_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [recordId, toVectorLiteral(embedding)],
    );
  }

  public async searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number): Promise<VectorSearchResult[]> {
    if (!this.vecReady) return [];
    if (this.vecDimensions !== queryEmbedding.length) {
      await this.initVec(queryEmbedding.length);
    }
    if (!this.vecDimensions) return [];
    try {
      const rows = await this.rows<any>(
        `SELECT v.record_id, (v.embedding <=> $1::vector) AS distance,
                r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
                r.session_key, r.timestamp_str, r.created_time
           FROM cognitive_vec v
           JOIN cognitive_records r ON v.record_id = r.record_id
          WHERE r.user_id = $2 AND r.invalid_at IS NULL AND r.archived = 0
          ORDER BY v.embedding <=> $1::vector
          LIMIT $3`,
        [toVectorLiteral(queryEmbedding), userId, limit],
      );
      return rows.map((r) => ({
        record_id: r.record_id, user_id: r.user_id, content: r.content, type: r.type,
        priority: asNumber(r.priority, 50), scene_name: r.scene_name, skill_tag: r.skill_tag,
        score: 1 - asNumber(r.distance), timestamp_str: r.timestamp_str,
        timestamp_start: "", timestamp_end: "", session_key: r.session_key, session_id: "",
        metadata_json: "{}", created_time: r.created_time,
      }));
    } catch (e) {
      console.error("[BrainRouter] Vector search failed:", e);
      return [];
    }
  }

  // ── contradictions ───────────────────────────────────────────────────

  public async upsertContradiction(data: {
    id: string; userId: string; recordIdA: string; recordIdB: string; reason: string; confidence: number; createdTime?: string;
  }): Promise<void> {
    await this.run(
      `INSERT INTO contradictions (id, user_id, record_id_a, record_id_b, reason, confidence, created_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET reason=EXCLUDED.reason, confidence=EXCLUDED.confidence`,
      [data.id, data.userId, data.recordIdA, data.recordIdB, data.reason, data.confidence, data.createdTime ?? new Date().toISOString()],
    );
  }

  public async getPendingContradictions(userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>): Promise<ContradictionRecord[]> {
    const where = ["c.user_id = ?", "c.status = 'pending'"];
    const args: any[] = [userId];
    if (pagination?.cursor) {
      where.push("(c.confidence < ? OR (c.confidence = ? AND c.id > ?))");
      args.push(pagination.cursor.confidence, pagination.cursor.confidence, pagination.cursor.id);
    }
    args.push(pagination?.limit ?? 20);
    const rows = await this.rows<any>(
      pg(`SELECT c.*, r1.content AS content_a, r2.content AS content_b
            FROM contradictions c
            JOIN cognitive_records r1 ON c.record_id_a = r1.record_id
            JOIN cognitive_records r2 ON c.record_id_b = r2.record_id
           WHERE ${where.join(" AND ")}
           ORDER BY c.confidence DESC, c.id ASC LIMIT ?`),
      args,
    );
    return rows as unknown as ContradictionRecord[];
  }

  public async resolveContradiction(id: string, userId: string, status: "resolved" | "dismissed"): Promise<void> {
    await this.run("UPDATE contradictions SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, userId]);
    await this.insertOperation({
      id: randomUUID(), userId, recordId: id, operation: "contradiction_resolve", actor: "system",
      sessionKey: "", reason: status, createdAt: new Date().toISOString(), metadata: { contradictionId: id, status },
    });
  }

  // ── skill hints / activations ───────────────────────────────────────────

  public async upsertSkillHints(skillName: string, hints: string, sourceFile = ""): Promise<void> {
    await this.run(
      `INSERT INTO skill_extraction_hints (skill_name, hints, source_file, registered_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (skill_name) DO UPDATE SET hints=EXCLUDED.hints, source_file=EXCLUDED.source_file, registered_at=EXCLUDED.registered_at`,
      [skillName, hints, sourceFile, new Date().toISOString()],
    );
  }

  public async listSkillHints(): Promise<SkillHintsRecord[]> {
    const rows = await this.rows<any>("SELECT skill_name, hints, source_file, registered_at FROM skill_extraction_hints ORDER BY registered_at DESC");
    return rows.map((r) => ({ skillName: r.skill_name, hints: r.hints, sourceFile: r.source_file, registeredAt: r.registered_at }));
  }

  public async getSkillHints(skillName: string): Promise<string | null> {
    const row = await this.one<{ hints: string }>("SELECT hints FROM skill_extraction_hints WHERE skill_name = $1", [skillName]);
    return row?.hints ?? null;
  }

  public async getSkillActivations(userId: string): Promise<SkillActivationRecord[]> {
    const rows = await this.rows<any>(
      "SELECT skill_name, potential, last_decay_time FROM skill_activations WHERE user_id = $1 ORDER BY potential DESC, skill_name ASC",
      [userId],
    );
    return rows.map((r) => ({ skillName: r.skill_name, potential: asNumber(r.potential), lastDecayTime: r.last_decay_time }));
  }

  public async upsertSkillActivations(userId: string, activations: SkillActivationRecord[]): Promise<void> {
    if (activations.length === 0) return;
    await this.tx(async (client) => {
      for (const record of activations) {
        await client.query(
          `INSERT INTO skill_activations (user_id, skill_name, potential, last_decay_time)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, skill_name) DO UPDATE SET potential=EXCLUDED.potential, last_decay_time=EXCLUDED.last_decay_time`,
          [userId, record.skillName, record.potential, record.lastDecayTime],
        );
      }
    });
  }

  // ── contextual focus ───────────────────────────────────────────────────

  public async upsertContextualFocus(record: ContextualFocusRecord): Promise<void> {
    await this.run(
      `INSERT INTO contextual_focus (id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, scene_name) DO UPDATE SET
         summary_md=EXCLUDED.summary_md, heat_score=EXCLUDED.heat_score,
         last_active_time=EXCLUDED.last_active_time, updated_time=EXCLUDED.updated_time`,
      [record.id, record.userId, record.sceneName, record.summaryMd, record.heatScore, record.lastActiveTime, record.createdTime, record.updatedTime],
    );
  }

  private focusRow(r: any): ContextualFocusRecord {
    return {
      id: r.id, userId: r.user_id, sceneName: r.scene_name, summaryMd: r.summary_md,
      heatScore: asNumber(r.heat_score), lastActiveTime: r.last_active_time,
      createdTime: r.created_time, updatedTime: r.updated_time,
    };
  }

  public async getTopContextualFocus(userId: string, limit = 3, cursor?: { heatScore: number; id: string }): Promise<ContextualFocusRecord[]> {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (cursor) {
      where.push("(heat_score < ? OR (heat_score = ? AND id > ?))");
      args.push(cursor.heatScore, cursor.heatScore, cursor.id);
    }
    args.push(limit);
    const rows = await this.rows<any>(
      pg(`SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time
            FROM contextual_focus WHERE ${where.join(" AND ")}
           ORDER BY heat_score DESC, id ASC LIMIT ?`),
      args,
    );
    return rows.map((r) => this.focusRow(r));
  }

  public async decayContextualFocusHeatScores(userId: string, decayFactor = 0.95): Promise<void> {
    await this.run("UPDATE contextual_focus SET heat_score = heat_score * $1 WHERE user_id = $2", [decayFactor, userId]);
  }

  public async boostContextualFocusHeatScore(userId: string, sceneName: string, boost = 20): Promise<void> {
    await this.run(
      "UPDATE contextual_focus SET heat_score = LEAST(100.0, heat_score + $1), last_active_time = $2 WHERE user_id = $3 AND scene_name = $4",
      [boost, new Date().toISOString(), userId, sceneName],
    );
  }

  public async getCognitivesByFocus(userId: string, sceneName: string, limit = 30): Promise<any[]> {
    return this.rows(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = $1 AND scene_name = $2 AND invalid_at IS NULL ORDER BY priority DESC LIMIT $3",
      [userId, sceneName, limit],
    );
  }

  public async getContextualFocusCount(userId: string): Promise<number> {
    const row = await this.one<{ count: string }>("SELECT COUNT(*) AS count FROM contextual_focus WHERE user_id = $1", [userId]);
    return asNumber(row?.count);
  }

  public async getColdContextualFocus(userId: string, limit: number): Promise<ContextualFocusRecord[]> {
    const rows = await this.rows<any>(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = $1 ORDER BY heat_score ASC LIMIT $2",
      [userId, limit],
    );
    return rows.map((r) => this.focusRow(r));
  }

  public async deleteContextualFocus(userId: string, sceneIds: string[]): Promise<void> {
    if (sceneIds.length === 0) return;
    await this.run("DELETE FROM contextual_focus WHERE user_id = $1 AND id = ANY($2::text[])", [userId, sceneIds]);
  }

  public async getContextualFocusByName(userId: string, sceneName: string): Promise<ContextualFocusRecord | null> {
    const row = await this.one<any>(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = $1 AND scene_name = $2",
      [userId, sceneName],
    );
    return row ? this.focusRow(row) : null;
  }

  public async getDistinctSceneNames(userId: string): Promise<string[]> {
    const rows = await this.rows<{ scene_name: string }>("SELECT DISTINCT scene_name FROM cognitive_records WHERE user_id = $1 AND scene_name != ''", [userId]);
    return rows.map((r) => r.scene_name);
  }

  public async renameFocusInCognitiveRecords(userId: string, oldName: string, canonicalName: string): Promise<void> {
    await this.tx(async (client) => {
      await client.query("UPDATE cognitive_records SET scene_name = $1, updated_time = $2 WHERE user_id = $3 AND scene_name = $4", [canonicalName, new Date().toISOString(), userId, oldName]);
      await client.query("DELETE FROM contextual_focus WHERE user_id = $1 AND scene_name = $2", [userId, oldName]);
    });
  }

  // ── workspace / project tags ─────────────────────────────────────────────

  public async getWorkspaceTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (recordIds.length === 0) return result;
    for (const id of recordIds) result.set(id, null);
    const rows = await this.rows<{ record_id: string; workspace_tag: string | null }>(
      "SELECT record_id, workspace_tag FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
      [userId, recordIds],
    );
    for (const row of rows) result.set(row.record_id, row.workspace_tag ?? null);
    return result;
  }

  public async getProjectTagsByRecordIds(userId: string, recordIds: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (recordIds.length === 0) return result;
    for (const id of recordIds) result.set(id, null);
    const rows = await this.rows<{ record_id: string; project_tag: string | null }>(
      "SELECT record_id, project_tag FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
      [userId, recordIds],
    );
    for (const row of rows) result.set(row.record_id, row.project_tag ?? null);
    return result;
  }

  // ── active sessions (federation) ─────────────────────────────────────────

  public async registerActiveSession(record: ActiveSessionRecord): Promise<ActiveSessionRecord> {
    await this.run(
      `INSERT INTO active_sessions (session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (session_key, user_id) DO UPDATE SET
         client_kind = EXCLUDED.client_kind,
         workspace_root = EXCLUDED.workspace_root,
         last_heartbeat_at = EXCLUDED.last_heartbeat_at,
         metadata_json = EXCLUDED.metadata_json,
         usage_json = COALESCE(EXCLUDED.usage_json, active_sessions.usage_json)`,
      [record.sessionKey, record.userId, record.clientKind, record.workspaceRoot, record.startedAt, record.lastHeartbeatAt, JSON.stringify(record.metadata ?? {}), record.usage ? JSON.stringify(record.usage) : null],
    );
    return (await this.getActiveSession(record.userId, record.sessionKey))!;
  }

  public async heartbeatActiveSession(userId: string, sessionKey: string, at: string, usage?: ActiveSessionUsage | null): Promise<boolean> {
    const changed = await this.run(
      `UPDATE active_sessions SET last_heartbeat_at = $1, usage_json = COALESCE($2, usage_json) WHERE session_key = $3 AND user_id = $4`,
      [at, usage ? JSON.stringify(usage) : null, sessionKey, userId],
    );
    return changed > 0;
  }

  public async listActiveSessions(filters: ActiveSessionFilters): Promise<ActiveSessionRecord[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.userId) { where.push("user_id = ?"); params.push(filters.userId); }
    if (filters.clientKind) { where.push("client_kind = ?"); params.push(filters.clientKind); }
    if (filters.workspaceRoot) { where.push("workspace_root = ?"); params.push(filters.workspaceRoot); }
    if (!filters.includeStale) {
      const threshold = filters.staleThresholdMs ?? 2 * 60 * 1000;
      where.push("last_heartbeat_at >= ?");
      params.push(new Date(Date.now() - threshold).toISOString());
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await this.rows<any>(
      pg(`SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
            FROM active_sessions ${whereSql}
           ORDER BY last_heartbeat_at DESC, session_key ASC`),
      params,
    );
    return rows.map((row) => activeSessionRowToRecord(row, filters.includeUsage ?? false));
  }

  public async unregisterActiveSession(userId: string, sessionKey: string): Promise<boolean> {
    const changed = await this.run("DELETE FROM active_sessions WHERE session_key = $1 AND user_id = $2", [sessionKey, userId]);
    return changed > 0;
  }

  public async sweepActiveSessions(olderThanMs: number): Promise<number> {
    return this.run("DELETE FROM active_sessions WHERE last_heartbeat_at < $1", [new Date(Date.now() - olderThanMs).toISOString()]);
  }

  private async getActiveSession(userId: string, sessionKey: string): Promise<ActiveSessionRecord | null> {
    const row = await this.one<any>(
      `SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
         FROM active_sessions WHERE session_key = $1 AND user_id = $2`,
      [sessionKey, userId],
    );
    return row ? activeSessionRowToRecord(row, true) : null;
  }

  // ── session inbox (federation) ───────────────────────────────────────────

  public async sendSessionMessage(
    record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">,
    options?: { idGenerator?: () => string; now?: string },
  ): Promise<SessionInboxRecord[]> {
    const now = options?.now ?? new Date().toISOString();
    const idFor = options?.idGenerator ?? (() => randomUUID());
    const recipients = await this.resolveInboxRecipients(record.userId, record.toSessionKey);
    if (recipients.length === 0) return [];
    const rows: SessionInboxRecord[] = [];
    await this.tx(async (client) => {
      for (const recipientSessionKey of recipients) {
        const id = idFor();
        await client.query(
          `INSERT INTO session_inbox (id, user_id, from_session_key, to_session_key, kind, payload_json, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, record.userId, record.fromSessionKey, recipientSessionKey, record.kind, JSON.stringify(record.payload ?? {}), now],
        );
        rows.push({
          id, userId: record.userId, fromSessionKey: record.fromSessionKey, toSessionKey: recipientSessionKey,
          kind: record.kind, payload: record.payload ?? {}, createdAt: now, deliveredAt: null,
        });
      }
    });
    return rows;
  }

  private async resolveInboxRecipients(userId: string, address: string): Promise<string[]> {
    if (!address) return [];
    if (address === "*" || address.toLowerCase() === "broadcast") {
      return this.activeSessionKeysForUser(userId);
    }
    const wildcardMatch = /^([^:]+):\*$/.exec(address);
    if (wildcardMatch) {
      return this.activeSessionKeysForUser(userId, wildcardMatch[1]);
    }
    return [address];
  }

  private async activeSessionKeysForUser(userId: string, clientKindFilter?: string): Promise<string[]> {
    const activeCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const rows = clientKindFilter
      ? await this.rows<{ session_key: string }>(
          "SELECT session_key FROM active_sessions WHERE user_id = $1 AND client_kind = $2 AND last_heartbeat_at >= $3",
          [userId, clientKindFilter, activeCutoff],
        )
      : await this.rows<{ session_key: string }>(
          "SELECT session_key FROM active_sessions WHERE user_id = $1 AND last_heartbeat_at >= $2",
          [userId, activeCutoff],
        );
    return rows.map((r) => r.session_key);
  }

  public async readSessionInbox(filters: SessionInboxFilters): Promise<SessionInboxRecord[]> {
    const limit = filters.limit ?? 50;
    const includeDelivered = filters.includeDelivered ?? false;
    const where: string[] = ["user_id = ?", "to_session_key = ?"];
    const params: any[] = [filters.userId, filters.toSessionKey];
    if (!includeDelivered) where.push("delivered_at IS NULL");
    params.push(limit);
    const rows = await this.rows<any>(
      pg(`SELECT id, user_id, from_session_key, to_session_key, kind, payload_json, created_at, delivered_at
            FROM session_inbox WHERE ${where.join(" AND ")}
           ORDER BY created_at ASC, id ASC LIMIT ?`),
      params,
    );
    return rows.map(inboxRowToRecord);
  }

  public async ackSessionInbox(userId: string, toSessionKey: string, ids: string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const capped = ids.slice(0, 500);
    return this.run(
      `UPDATE session_inbox SET delivered_at = $1
        WHERE user_id = $2 AND to_session_key = $3 AND delivered_at IS NULL AND id = ANY($4::text[])`,
      [at, userId, toSessionKey, capped],
    );
  }

  public async sweepSessionInbox(olderThanMs: number): Promise<number> {
    return this.run(
      "DELETE FROM session_inbox WHERE delivered_at IS NOT NULL AND delivered_at < $1",
      [new Date(Date.now() - olderThanMs).toISOString()],
    );
  }

  // ── pending delegations (federation) ─────────────────────────────────────

  private rowToPendingDelegation(row: any): PendingDelegationRecord {
    return {
      id: row.id,
      userId: row.user_id,
      fromSessionKey: row.from_session_key,
      toAgentKind: row.to_agent_kind,
      toSessionKey: row.to_session_key ?? null,
      packet: (typeof row.packet_json === "string" ? JSON.parse(row.packet_json || "{}") : (row.packet_json ?? {})) as DelegationPacket,
      status: row.status as PendingDelegationStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at ?? null,
    };
  }

  public async enqueuePendingDelegation(input: PendingDelegationEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<PendingDelegationRecord> {
    const now = options?.now ?? new Date().toISOString();
    const id = (options?.idGenerator ?? (() => randomUUID()))();
    await this.run(
      `INSERT INTO pending_delegations (id, user_id, from_session_key, to_agent_kind, to_session_key, packet_json, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NULL,$5,'pending',$6,$7)`,
      [id, input.userId, input.fromSessionKey, input.toAgentKind, JSON.stringify(input.packet ?? {}), now, now],
    );
    return {
      id, userId: input.userId, fromSessionKey: input.fromSessionKey, toAgentKind: input.toAgentKind,
      toSessionKey: null, packet: input.packet, status: "pending", createdAt: now, updatedAt: now, claimedAt: null,
    };
  }

  public async listPendingDelegations(filters: PendingDelegationFilters): Promise<PendingDelegationRecord[]> {
    const clauses = ["user_id = ?"];
    const params: any[] = [filters.userId];
    if (filters.toAgentKind) { clauses.push("to_agent_kind = ?"); params.push(filters.toAgentKind); }
    if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    params.push(limit);
    const rows = await this.rows<any>(
      pg(`SELECT * FROM pending_delegations WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`),
      params,
    );
    return rows.map((r) => this.rowToPendingDelegation(r));
  }

  public async claimPendingDelegation(userId: string, toAgentKind: string, toSessionKey: string, at: string): Promise<PendingDelegationRecord | null> {
    // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED so concurrent claimers get
    // distinct rows (the pg analogue of the SQLite single-writer SELECT→UPDATE).
    return this.tx(async (client) => {
      const sel = await client.query<any>(
        `SELECT * FROM pending_delegations
          WHERE user_id = $1 AND to_agent_kind = $2 AND status = 'pending'
          ORDER BY created_at ASC LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [userId, toAgentKind],
      );
      const row = sel.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE pending_delegations SET status = 'claimed', to_session_key = $1, claimed_at = $2, updated_at = $3 WHERE id = $4`,
        [toSessionKey, at, at, row.id],
      );
      return this.rowToPendingDelegation({ ...row, status: "claimed", to_session_key: toSessionKey, claimed_at: at, updated_at: at });
    });
  }

  // ── memory jobs queue (BRAIN-P1) ─────────────────────────────────────────

  private static readonly JOB_COLUMNS =
    "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at";

  public async enqueueMemoryJob(input: MemoryJobEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<MemoryJobRecord> {
    const now = options?.now ?? new Date().toISOString();
    const id = (options?.idGenerator ?? (() => randomUUID()))();
    await this.run(
      `INSERT INTO memory_jobs (id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at)
       VALUES ($1,$2,'pending',$3,0,$4,$5,NULL,$6,$7,NULL,NULL,$8,$9)`,
      [id, input.kind, input.priority ?? 50, input.maxAttempts ?? 3, input.runAfter ?? now, input.parentJobId ?? null, JSON.stringify(input.input ?? {}), now, now],
    );
    return (await this.getMemoryJob(id))!;
  }

  public async getMemoryJob(id: string): Promise<MemoryJobRecord | null> {
    const row = await this.one(`SELECT ${PostgresMemoryStore.JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [id]);
    return row ? jobRowToRecord(row as any) : null;
  }

  public async listMemoryJobs(filters?: MemoryJobListFilters): Promise<MemoryJobRecord[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filters?.kind) { where.push("kind = ?"); params.push(filters.kind); }
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    params.push(filters?.limit ?? 100);
    const rows = await this.rows(
      pg(`SELECT ${PostgresMemoryStore.JOB_COLUMNS} FROM memory_jobs
            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`),
      params,
    );
    return rows.map((r) => jobRowToRecord(r as any));
  }

  public async claimNextMemoryJob(options?: { now?: string }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    return this.tx(async (client) => {
      const sel = await client.query<{ id: string }>(
        `SELECT id FROM memory_jobs
          WHERE status = 'pending' AND run_after <= $1
          ORDER BY priority DESC, run_after ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [now],
      );
      const candidate = sel.rows[0];
      if (!candidate) return null;
      await client.query(
        "UPDATE memory_jobs SET status = 'running', locked_at = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
        [now, now, candidate.id],
      );
      const row = (await client.query(`SELECT ${PostgresMemoryStore.JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [candidate.id])).rows[0];
      return row ? jobRowToRecord(row as any) : null;
    });
  }

  public async startMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    const changed = await this.run(
      "UPDATE memory_jobs SET status = 'running', locked_at = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
      [now, now, id],
    );
    if (changed === 0) return null;
    return this.getMemoryJob(id);
  }

  public async completeMemoryJob(id: string, output: unknown, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    const changed = await this.run(
      "UPDATE memory_jobs SET status = 'done', output_json = $1, error = NULL, locked_at = NULL, updated_at = $2 WHERE id = $3 AND status = 'running'",
      [JSON.stringify(output ?? null), now, id],
    );
    if (changed === 0) return null;
    return this.getMemoryJob(id);
  }

  public async failMemoryJob(id: string, error: string, options?: { now?: string; backoffMs?: number }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    const job = await this.getMemoryJob(id);
    if (!job || job.status !== "running") return null;
    const attempts = job.attempts + 1;
    if (attempts < job.maxAttempts) {
      const runAfter = new Date(Date.parse(now) + (options?.backoffMs ?? 0)).toISOString();
      await this.run(
        "UPDATE memory_jobs SET status = 'pending', attempts = $1, error = $2, run_after = $3, locked_at = NULL, updated_at = $4 WHERE id = $5",
        [attempts, error, runAfter, now, id],
      );
    } else {
      await this.run(
        "UPDATE memory_jobs SET status = 'failed', attempts = $1, error = $2, locked_at = NULL, updated_at = $3 WHERE id = $4",
        [attempts, error, now, id],
      );
    }
    return this.getMemoryJob(id);
  }

  public async retryMemoryJob(id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    await this.run(
      "UPDATE memory_jobs SET status = 'pending', attempts = 0, run_after = $1, locked_at = NULL, error = NULL, updated_at = $2 WHERE id = $3 AND status IN ('failed', 'cancelled')",
      [now, now, id],
    );
    return this.getMemoryJob(id);
  }

  public async cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): Promise<MemoryJobRecord | null> {
    const now = options?.now ?? new Date().toISOString();
    await this.run(
      "UPDATE memory_jobs SET status = 'cancelled', error = COALESCE($1, error), locked_at = NULL, updated_at = $2 WHERE id = $3 AND status IN ('pending', 'running')",
      [options?.reason ?? null, now, id],
    );
    return this.getMemoryJob(id);
  }

  public async sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string }): Promise<number> {
    const now = options?.now ?? new Date().toISOString();
    const cutoff = new Date(Date.parse(now) - stuckMs).toISOString();
    return this.run(
      "UPDATE memory_jobs SET status = 'cancelled', error = 'swept: lock expired', locked_at = NULL, updated_at = $1 WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < $2",
      [now, cutoff],
    );
  }

  public async getMemoryJobKindAggregates(options?: { now?: string }): Promise<MemoryJobKindAggregate[]> {
    const now = options?.now ?? new Date().toISOString();
    const since24h = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const kinds = (await this.rows<{ kind: string }>("SELECT DISTINCT kind FROM memory_jobs ORDER BY kind ASC")).map((r) => r.kind);
    const out: MemoryJobKindAggregate[] = [];
    for (const kind of kinds) {
      const latest = await this.one<{ status: string; updated_at: string }>(
        "SELECT status, updated_at FROM memory_jobs WHERE kind = $1 ORDER BY updated_at DESC, id DESC LIMIT 1", [kind],
      );
      const lastCompleted = await this.one<{ updated_at: string }>(
        "SELECT updated_at FROM memory_jobs WHERE kind = $1 AND status = 'done' ORDER BY updated_at DESC LIMIT 1", [kind],
      );
      const pending = await this.one<{ n: string }>("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = $1 AND status = 'pending'", [kind]);
      const terminal = await this.one<{ done: string | null; failed: string | null }>(
        `SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM memory_jobs WHERE kind = $1 AND updated_at >= $2 AND status IN ('done','failed')`,
        [kind, since24h],
      );
      const done = asNumber(terminal?.done);
      const failed = asNumber(terminal?.failed);
      const total = done + failed;
      out.push({
        kind,
        lastStatus: (latest?.status ?? "pending") as MemoryJobStatus,
        lastCompletedAt: lastCompleted?.updated_at ?? null,
        pendingJobs: asNumber(pending?.n),
        successRate24h: total > 0 ? done / total : null,
      });
    }
    return out;
  }

  // ── compression cache (CCR) ──────────────────────────────────────────────

  private ccrToMetadata(row: any): CompressionEntryMetadata {
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

  private async ccrPurgeExpired(now: number): Promise<void> {
    if (now - this.ccrLastPurgeAt < PURGE_INTERVAL_SECONDS) return;
    await this.run("DELETE FROM ccr_entries WHERE created_at + ttl <= $1", [now]);
    this.ccrLastPurgeAt = now;
  }

  private async ccrGetRow(userId: string, hash: string): Promise<any | null> {
    return this.one(
      `SELECT hash, user_id, original_content, compressed_content, original_tokens, compressed_tokens,
              original_item_count, compressed_item_count, tool_name, query_context, compression_strategy,
              created_at, ttl, retrieval_count, last_accessed
         FROM ccr_entries WHERE hash = $1 AND user_id = $2`,
      [hash, userId],
    );
  }

  public async storeCompressionEntry(input: CompressionEntryInput): Promise<CompressionEntryMetadata> {
    const now = this.ccrClock();
    await this.ccrPurgeExpired(now);
    const computedHash = hashContent(input.originalContent);
    const hash = input.hash ?? computedHash;
    assertHash(hash);
    if (hash !== computedHash) throw new Error("Compression hash does not match the original content.");

    const existing = await this.ccrGetRow(input.userId, hash);
    if (existing) return this.ccrToMetadata(existing);

    await this.run(
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
        now, this.ccrTtlSeconds,
      ],
    );
    await this.ccrEvictOverflow();
    return (await this.getCompressionEntryMetadata(input.userId, hash))!;
  }

  private async ccrEvictOverflow(): Promise<void> {
    const row = await this.one<{ count: string }>("SELECT COUNT(*) AS count FROM ccr_entries");
    const overflow = asNumber(row?.count) - this.ccrMaxEntries;
    if (overflow <= 0) return;
    // ctid identifies exactly one physical row (pg analogue of SQLite rowid),
    // so eviction can't drop another tenant's still-fresh row that shares a hash.
    await this.run(
      `DELETE FROM ccr_entries
        WHERE ctid IN (SELECT ctid FROM ccr_entries ORDER BY created_at ASC, ctid ASC LIMIT $1)`,
      [overflow],
    );
  }

  public async retrieveCompressionEntry(userId: string, hash: string, query?: string): Promise<CompressionRetrieval | null> {
    if (!HASH_PATTERN.test(hash)) return null;
    const now = this.ccrClock();
    const row = await this.ccrGetRow(userId, hash);
    if (!row) return null;
    if (asNumber(row.created_at) + asNumber(row.ttl) <= now) {
      await this.run("DELETE FROM ccr_entries WHERE hash = $1 AND user_id = $2", [hash, userId]);
      return null;
    }
    const retrievalCount = asNumber(row.retrieval_count) + 1;
    await this.run("UPDATE ccr_entries SET retrieval_count = $1, last_accessed = $2 WHERE hash = $3 AND user_id = $4", [retrievalCount, now, hash, userId]);
    const entry = this.ccrToMetadata({ ...row, retrieval_count: retrievalCount, last_accessed: now });
    const results = query ? this.ccrSelectQueryResults(row.original_content, query) : null;
    if (results) return { kind: "subset", entry, results };
    return { kind: "full", entry, originalContent: row.original_content };
  }

  public async getCompressionEntryMetadata(userId: string, hash: string): Promise<CompressionEntryMetadata | null> {
    if (!HASH_PATTERN.test(hash)) return null;
    const row = await this.ccrGetRow(userId, hash);
    return row ? this.ccrToMetadata(row) : null;
  }

  public async getCompressionStats(userId: string): Promise<CompressionStats> {
    await this.ccrPurgeExpired(this.ccrClock());
    const aggregate = await this.one<any>(
      `SELECT COUNT(*) AS compressions,
              COALESCE(SUM(retrieval_count), 0) AS retrievals,
              COALESCE(SUM(original_tokens), 0) AS original_tokens,
              COALESCE(SUM(compressed_tokens), 0) AS compressed_tokens
         FROM ccr_entries WHERE user_id = $1`,
      [userId],
    );
    const recentEvents = await this.rows<any>(
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
      store: { entries: asNumber(aggregate?.compressions), maxEntries: this.ccrMaxEntries },
    };
  }

  private ccrSelectQueryResults(originalContent: string, query: string): unknown[] | null {
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

  // ── core identity ─────────────────────────────────────────────────────

  public async upsertCoreIdentity(record: CoreIdentityRecord): Promise<void> {
    await this.run(
      `INSERT INTO core_identity (user_id, persona_md, cognitive_count_at_generation, created_time, updated_time)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         persona_md=EXCLUDED.persona_md,
         cognitive_count_at_generation=EXCLUDED.cognitive_count_at_generation,
         updated_time=EXCLUDED.updated_time`,
      [record.userId, record.personaMd, record.cognitiveCountAtGeneration, record.createdTime, record.updatedTime],
    );
  }

  public async getCoreIdentity(userId: string): Promise<CoreIdentityRecord | null> {
    const row = await this.one<any>("SELECT user_id, persona_md, cognitive_count_at_generation, created_time, updated_time FROM core_identity WHERE user_id = $1", [userId]);
    if (!row) return null;
    return {
      userId: row.user_id, personaMd: row.persona_md,
      cognitiveCountAtGeneration: asNumber(row.cognitive_count_at_generation),
      createdTime: row.created_time, updatedTime: row.updated_time,
    };
  }

  // ── Atlas graph persistence (REMOTE-BRAIN Phase 3) ──────────────────────

  public async putAtlasGraph(userId: string, workspaceTag: string, graph: AtlasGraph): Promise<void> {
    const nodeCount = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
    await this.run(
      `INSERT INTO atlas_graphs (user_id, workspace_tag, graph_json, node_count, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, workspace_tag) DO UPDATE SET
         graph_json=EXCLUDED.graph_json,
         node_count=EXCLUDED.node_count,
         updated_at=EXCLUDED.updated_at`,
      [userId, workspaceTag, JSON.stringify(graph), nodeCount, new Date().toISOString()],
    );
  }

  public async getAtlasGraph(userId: string, workspaceTag: string): Promise<AtlasGraph | null> {
    const row = await this.one<{ graph_json: string }>(
      "SELECT graph_json FROM atlas_graphs WHERE user_id = $1 AND workspace_tag = $2",
      [userId, workspaceTag],
    );
    if (!row) return null;
    try {
      return JSON.parse(row.graph_json) as AtlasGraph;
    } catch {
      return null; // corrupt row — treat as absent rather than throwing
    }
  }

  public async listAtlasWorkspaces(userId: string): Promise<AtlasWorkspaceSummary[]> {
    const rows = await this.rows<{ workspace_tag: string; node_count: unknown; updated_at: string }>(
      "SELECT workspace_tag, node_count, updated_at FROM atlas_graphs WHERE user_id = $1 ORDER BY updated_at DESC",
      [userId],
    );
    return rows.map((r) => ({
      workspaceTag: r.workspace_tag,
      nodeCount: asNumber(r.node_count),
      updatedAt: r.updated_at,
    }));
  }

  public async getIdentityAndInstructionCognitives(userId: string, limit = 100): Promise<any[]> {
    return this.rows(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = $1 AND type IN ('persona','instruction') AND invalid_at IS NULL ORDER BY priority DESC, created_time DESC LIMIT $2",
      [userId, limit],
    );
  }

  // ── scheduler state ───────────────────────────────────────────────────

  public async getSchedulerState(userId: string): Promise<SchedulerState> {
    const row = await this.one<any>(
      "SELECT cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count, extraction_errors, last_error_message, last_error_at FROM scheduler_state WHERE user_id = $1",
      [userId],
    );
    if (!row) {
      return { cognitiveCountSinceLastFocus: 0, cognitiveCountSinceLastIdentity: 0, totalCognitiveCount: 0, extractionErrors: 0, lastErrorMessage: null, lastErrorAt: null };
    }
    return {
      cognitiveCountSinceLastFocus: asNumber(row.cognitive_count_since_last_focus),
      cognitiveCountSinceLastIdentity: asNumber(row.cognitive_count_since_last_identity),
      totalCognitiveCount: asNumber(row.total_cognitive_count),
      extractionErrors: asNumber(row.extraction_errors),
      lastErrorMessage: row.last_error_message ?? null,
      lastErrorAt: row.last_error_at ?? null,
    };
  }

  public async incrementSchedulerCognitiveCount(userId: string, count: number): Promise<void> {
    await this.run(
      `INSERT INTO scheduler_state (user_id, cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         cognitive_count_since_last_focus = scheduler_state.cognitive_count_since_last_focus + EXCLUDED.cognitive_count_since_last_focus,
         cognitive_count_since_last_identity = scheduler_state.cognitive_count_since_last_identity + EXCLUDED.cognitive_count_since_last_identity,
         total_cognitive_count = scheduler_state.total_cognitive_count + EXCLUDED.total_cognitive_count`,
      [userId, count, count, count],
    );
  }

  public async resetSchedulerFocusCount(userId: string): Promise<void> {
    await this.run("UPDATE scheduler_state SET cognitive_count_since_last_focus = 0 WHERE user_id = $1", [userId]);
  }

  public async resetSchedulerIdentityCount(userId: string): Promise<void> {
    await this.run("UPDATE scheduler_state SET cognitive_count_since_last_identity = 0 WHERE user_id = $1", [userId]);
  }

  public async recordExtractionFailure(userId: string, message: string): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
       VALUES ($1,1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET
         extraction_errors = COALESCE(scheduler_state.extraction_errors, 0) + 1,
         last_error_message = EXCLUDED.last_error_message,
         last_error_at = EXCLUDED.last_error_at`,
      [userId, message.slice(0, 1000), now],
    );
  }

  public async resetExtractionFailures(userId: string): Promise<void> {
    await this.run(
      `INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
       VALUES ($1,0,NULL,NULL)
       ON CONFLICT (user_id) DO UPDATE SET extraction_errors = 0, last_error_message = NULL, last_error_at = NULL`,
      [userId],
    );
  }

  public async getExtractionStatus(userId: string): Promise<ExtractionStatus> {
    const state = await this.getSchedulerState(userId);
    return {
      extractionErrors: state.extractionErrors,
      lastErrorMessage: state.lastErrorMessage,
      lastErrorAt: state.lastErrorAt,
      syncPaused: state.extractionErrors >= 5,
    };
  }

  public async sweepUnextractedBacklog(options: { olderThanMs: number; minUnextracted?: number; maxFailures?: number; limit?: number }): Promise<StalledExtractionBacklog[]> {
    const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
    const minUnextracted = options.minUnextracted ?? 1;
    const maxFailures = options.maxFailures ?? 5;
    const limit = options.limit ?? 20;
    const rows = await this.rows<any>(
      `SELECT
         l0.user_id,
         l0.session_key,
         COALESCE(MAX(l0.session_id), '') AS session_id,
         COUNT(*) AS unextracted_count,
         MAX(l0.recorded_at) AS latest_recorded_at,
         COALESCE(ss.extraction_errors, 0) AS extraction_errors,
         ss.last_error_message
       FROM sensory_stream l0
       LEFT JOIN scheduler_state ss ON ss.user_id = l0.user_id
       WHERE l0.extracted_at IS NULL
       GROUP BY l0.user_id, l0.session_key, ss.extraction_errors, ss.last_error_message
       HAVING COUNT(*) >= $1 AND MAX(l0.recorded_at) <= $2 AND COALESCE(ss.extraction_errors, 0) < $3
       ORDER BY MAX(l0.recorded_at) ASC
       LIMIT $4`,
      [minUnextracted, cutoff, maxFailures, limit],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      sessionKey: row.session_key,
      sessionId: row.session_id ?? "",
      unextractedCount: asNumber(row.unextracted_count),
      latestRecordedAt: row.latest_recorded_at ?? "",
      extractionErrors: asNumber(row.extraction_errors),
      lastErrorMessage: row.last_error_message ?? null,
    }));
  }

  // ── graph (nodes + edges) ─────────────────────────────────────────────

  public async getAllGraphNodes(userId: string): Promise<GraphNode[]> {
    const rows = await this.rows<any>(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1",
      [userId],
    );
    return rows.map((r) => this.graphNodeRow(r));
  }

  public async getAllGraphEdges(userId: string): Promise<GraphEdge[]> {
    const rows = await this.rows<any>(
      "SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time FROM graph_edges WHERE user_id = $1",
      [userId],
    );
    return rows.map((r) => this.graphEdgeRow(r));
  }

  private graphNodeRow(r: any): GraphNode {
    return {
      id: r.id, userId: r.user_id, entity: r.entity, entityType: r.entity_type,
      skillTag: r.skill_tag, confidence: asNumber(r.confidence, 1), sourceRecordId: r.source_record_id, createdTime: r.created_time,
    };
  }

  private graphEdgeRow(r: any): GraphEdge {
    return {
      id: r.id, userId: r.user_id, fromNodeId: r.from_node_id, toNodeId: r.to_node_id,
      relation: r.relation, skillTag: r.skill_tag, confidence: asNumber(r.confidence, 1),
      sourceRecordId: r.source_record_id, createdTime: r.created_time,
    };
  }

  public async upsertGraphNode(node: GraphNode): Promise<void> {
    await this.run(
      `INSERT INTO graph_nodes (id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         entity_type=EXCLUDED.entity_type, skill_tag=EXCLUDED.skill_tag,
         confidence=EXCLUDED.confidence, source_record_id=EXCLUDED.source_record_id`,
      [node.id, node.userId, node.entity, node.entityType, node.skillTag || "", node.confidence, node.sourceRecordId, node.createdTime],
    );
  }

  public async upsertGraphEdge(edge: GraphEdge): Promise<void> {
    await this.run(
      `INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, from_node_id, to_node_id, relation) DO UPDATE SET
         skill_tag=EXCLUDED.skill_tag, confidence=EXCLUDED.confidence,
         source_record_id=EXCLUDED.source_record_id, created_time=EXCLUDED.created_time`,
      [edge.id, edge.userId, edge.fromNodeId, edge.toNodeId, edge.relation, edge.skillTag || "", edge.confidence, edge.sourceRecordId, edge.createdTime],
    );
  }

  public async getGraphNodeByEntity(userId: string, entity: string): Promise<GraphNode | null> {
    const row = await this.one<any>(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1 AND LOWER(entity) = LOWER($2)",
      [userId, entity],
    );
    return row ? this.graphNodeRow(row) : null;
  }

  public async getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops = 2): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const visitedNodes = new Map<string, GraphNode>();
    const visitedEdges = new Map<string, GraphEdge>();
    const nodeById = async (id: string): Promise<GraphNode | null> => {
      const row = await this.one<any>(
        "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1 AND id = $2",
        [userId, id],
      );
      return row ? this.graphNodeRow(row) : null;
    };
    const start = await nodeById(entityId);
    if (!start) return { nodes: [], edges: [] };
    visitedNodes.set(start.id, start);

    let queue = [start.id];
    let currentHop = 0;
    while (queue.length > 0 && currentHop < maxHops) {
      const nextQueue: string[] = [];
      for (const nodeId of queue) {
        const params: any[] = [userId, nodeId, nodeId];
        let edgeSql =
          "SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time FROM graph_edges WHERE user_id = ? AND (from_node_id = ? OR to_node_id = ?)";
        if (skillTag) {
          edgeSql += " AND (skill_tag = ? OR skill_tag = '')";
          params.push(skillTag);
        }
        const edgeRows = await this.rows<any>(pg(edgeSql), params);
        for (const row of edgeRows) {
          const edge = this.graphEdgeRow(row);
          visitedEdges.set(edge.id, edge);
          const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
          if (!visitedNodes.has(neighborId)) {
            const neighbor = await nodeById(neighborId);
            if (neighbor) {
              visitedNodes.set(neighborId, neighbor);
              nextQueue.push(neighborId);
            }
          }
        }
      }
      queue = nextQueue;
      currentHop++;
    }
    return { nodes: Array.from(visitedNodes.values()), edges: Array.from(visitedEdges.values()) };
  }

  // ── ACE feedback loop ──────────────────────────────────────────────────

  public async markCited(userId: string, recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const now = new Date().toISOString();
    await this.run(
      `UPDATE cognitive_records SET citation_count = citation_count + 1, last_cited_at = $1, never_cited_count = 0, updated_time = $2
        WHERE user_id = $3 AND record_id = ANY($4::text[])`,
      [now, now, userId, recordIds],
    );
  }

  public async incrementNeverCited(userId: string, recordIds: string[]): Promise<{ recordId: string; neverCitedCount: number }[]> {
    if (recordIds.length === 0) return [];
    const now = new Date().toISOString();
    await this.run(
      "UPDATE cognitive_records SET never_cited_count = never_cited_count + 1, updated_time = $1 WHERE user_id = $2 AND record_id = ANY($3::text[])",
      [now, userId, recordIds],
    );
    const rows = await this.rows<any>(
      "SELECT record_id, never_cited_count FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
      [userId, recordIds],
    );
    return rows.map((r) => ({ recordId: r.record_id, neverCitedCount: asNumber(r.never_cited_count) }));
  }

  public async archiveCognitiveRecord(userId: string, recordId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.run("UPDATE cognitive_records SET archived = 1, status = 'archived', updated_time = $1 WHERE user_id = $2 AND record_id = $3", [now, userId, recordId]);
    await this.insertOperation({
      id: randomUUID(), userId, recordId, operation: "archive", actor: "system",
      sessionKey: "", reason: "", createdAt: now, metadata: {},
    });
  }

  public async getRecentSkillContextCognitives(userId: string, limit: number): Promise<{ skillTag: string; createdTime: string }[]> {
    const rows = await this.rows<any>(
      `SELECT skill_tag, created_time FROM cognitive_records
        WHERE user_id = $1 AND type = 'skill_context' AND skill_tag != '' AND invalid_at IS NULL AND archived = 0
        ORDER BY created_time DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({ skillTag: r.skill_tag, createdTime: r.created_time }));
  }

  // ── users ──────────────────────────────────────────────────────────────

  private userRow(row: any): UserRecord {
    return {
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    };
  }

  public async createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): Promise<UserRecord> {
    const createdAt = new Date().toISOString();
    await this.run(
      `INSERT INTO users (user_id, api_key, password_hash, display_name, email, is_admin, status, created_at)
       VALUES ($1,$2,NULL,$3,'',$4,'active',$5)`,
      [userId, apiKey, displayName, isAdmin ? 1 : 0, createdAt],
    );
    return { userId, apiKey, passwordHash: null, displayName, email: "", isAdmin, status: "active", createdAt };
  }

  public async getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
    const row = await this.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE api_key = $1", [apiKey]);
    return row ? this.userRow(row) : null;
  }

  public async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE lower(email) = lower($1)", [email]);
    return row ? this.userRow(row) : null;
  }

  public async getUserById(userId: string): Promise<UserRecord | null> {
    const row = await this.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE user_id = $1", [userId]);
    return row ? this.userRow(row) : null;
  }

  public async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.run("UPDATE users SET password_hash = $1 WHERE user_id = $2", [passwordHash, userId]);
  }
  public async updateUserEmail(userId: string, email: string): Promise<void> {
    await this.run("UPDATE users SET email = $1 WHERE user_id = $2", [email, userId]);
  }
  public async updateUserDisplayName(userId: string, displayName: string): Promise<void> {
    await this.run("UPDATE users SET display_name = $1 WHERE user_id = $2", [displayName, userId]);
  }
  public async updateUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
    await this.run("UPDATE users SET status = $1 WHERE user_id = $2", [status, userId]);
  }
  public async updateUserApiKey(userId: string, apiKey: string): Promise<void> {
    await this.run("UPDATE users SET api_key = $1 WHERE user_id = $2", [apiKey, userId]);
  }

  public async listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): Promise<UserRecord[]> {
    const where: string[] = [];
    const args: any[] = [];
    if (pagination?.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND user_id > ?))");
      args.push(pagination.cursor.createdAt, pagination.cursor.createdAt, pagination.cursor.userId);
    }
    args.push(pagination?.limit ?? 500);
    const rows = await this.rows(
      pg(`SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at
            FROM users ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY created_at DESC, user_id ASC LIMIT ?`),
      args,
    );
    return rows.map((row) => this.userRow(row));
  }

  public async deleteUser(userId: string): Promise<void> {
    await this.tx(async (client) => {
      for (const table of [
        "users", "sensory_stream", "cognitive_records", "contradictions", "contextual_focus",
        "core_identity", "scheduler_state", "graph_nodes", "graph_edges", "cognitive_connections",
        "memory_evidence", "memory_operations", "memory_file_index",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      }
    });
  }

  // ── list + stats ─────────────────────────────────────────────────────

  public async listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>,
  ): Promise<MemoryListItem[]> {
    const where: string[] = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.query) { where.push("content LIKE ?"); args.push(`%${filters.query}%`); }
    if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
    if (filters?.scene) { where.push("scene_name = ?"); args.push(filters.scene); }
    if (filters?.skill) { where.push("skill_tag = ?"); args.push(filters.skill); }
    if (typeof filters?.archived === "boolean") { where.push("archived = ?"); args.push(filters.archived ? 1 : 0); }
    if (pagination?.cursor) {
      where.push("(created_time < ? OR (created_time = ? AND record_id > ?))");
      args.push(pagination.cursor.createdTime, pagination.cursor.createdTime, pagination.cursor.recordId);
    }
    args.push(pagination?.limit ?? 500);
    const rows = await this.rows<any>(
      pg(`SELECT record_id, content, type, priority, scene_name, skill_tag, created_time, citation_count, never_cited_count, archived
            FROM cognitive_records WHERE ${where.join(" AND ")}
           ORDER BY created_time DESC, record_id ASC LIMIT ?`),
      args,
    );
    return rows.map((row) => ({
      recordId: row.record_id,
      content: row.content,
      type: row.type,
      priority: asNumber(row.priority, 50),
      sceneName: row.scene_name ?? "",
      skillTag: row.skill_tag ?? "",
      createdTime: row.created_time,
      citationCount: asNumber(row.citation_count),
      neverCitedCount: asNumber(row.never_cited_count),
      archived: Boolean(row.archived),
    }));
  }

  public async getMemoryStats(userId: string): Promise<{
    total: number; archived: number; byType: Record<string, number>; citationRate: number;
    lastRecallAt: string | null; sensoryTotal: number; sensoryUnextracted: number;
    focusSceneTotal: number; extraction: ExtractionStatus;
  }> {
    const totalRow = await this.one<{ c: string }>("SELECT COUNT(*) AS c FROM cognitive_records WHERE user_id = $1", [userId]);
    const archivedRow = await this.one<{ c: string }>("SELECT COUNT(*) AS c FROM cognitive_records WHERE user_id = $1 AND archived = 1", [userId]);
    const typeRows = await this.rows<{ type: string; c: string }>("SELECT type, COUNT(*) AS c FROM cognitive_records WHERE user_id = $1 GROUP BY type", [userId]);
    const citationRows = await this.one<{ cited: string | null; total: string }>("SELECT SUM(citation_count) AS cited, COUNT(*) AS total FROM cognitive_records WHERE user_id = $1", [userId]);
    const sensoryTotalRow = await this.one<{ c: string; last_at: string | null }>("SELECT COUNT(*) AS c, MAX(recorded_at) AS last_at FROM sensory_stream WHERE user_id = $1", [userId]);
    const sensoryUnextractedRow = await this.one<{ c: string }>("SELECT COUNT(*) AS c FROM sensory_stream WHERE user_id = $1 AND extracted_at IS NULL", [userId]);

    const byType: Record<string, number> = {};
    for (const row of typeRows) byType[row.type] = asNumber(row.c);

    const totalRecords = asNumber(totalRow?.c);
    const cited = asNumber(citationRows?.cited);
    return {
      total: totalRecords,
      archived: asNumber(archivedRow?.c),
      byType,
      citationRate: totalRecords > 0 ? cited / totalRecords : 0,
      lastRecallAt: sensoryTotalRow?.last_at ?? null,
      sensoryTotal: asNumber(sensoryTotalRow?.c),
      sensoryUnextracted: asNumber(sensoryUnextractedRow?.c),
      focusSceneTotal: await this.getContextualFocusCount(userId),
      extraction: await this.getExtractionStatus(userId),
    };
  }

  // ── dendritic connections ───────────────────────────────────────────────

  public async upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): Promise<void> {
    await this.run(
      `INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
       VALUES ($1,$2,$3,$4, now()::text)
       ON CONFLICT (user_id, source_id, target_id) DO UPDATE SET weight = EXCLUDED.weight, last_activated_at = now()::text`,
      [userId, sourceId, targetId, weight],
    );
  }

  public async getConnectionsForSource(userId: string, sourceId: string): Promise<Array<{ targetId: string; weight: number }>> {
    const rows = await this.rows<any>(
      "SELECT target_id, weight FROM cognitive_connections WHERE user_id = $1 AND source_id = $2 AND weight >= 0.1",
      [userId, sourceId],
    );
    return rows.map((r) => ({ targetId: r.target_id, weight: asNumber(r.weight) }));
  }

  public async strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): Promise<void> {
    if (pairs.length === 0) return;
    await this.tx(async (client) => {
      const sql =
        `INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
         VALUES ($1,$2,$3,$4, now()::text)
         ON CONFLICT (user_id, source_id, target_id) DO UPDATE SET
           weight = LEAST(1.0, cognitive_connections.weight + $5), last_activated_at = now()::text`;
      for (const pair of pairs) {
        await client.query(sql, [userId, pair.source, pair.target, delta, delta]);
        await client.query(sql, [userId, pair.target, pair.source, delta, delta]);
      }
    });
  }

  public async decayConnections(userId: string, decayFactor: number): Promise<void> {
    await this.run("UPDATE cognitive_connections SET weight = GREATEST(0.0, weight * $1) WHERE user_id = $2", [decayFactor, userId]);
  }

  public async pruneConnections(userId: string, threshold: number): Promise<void> {
    await this.run("DELETE FROM cognitive_connections WHERE user_id = $1 AND weight < $2", [userId, threshold]);
  }

  public async getAllConnections(userId: string): Promise<Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }>> {
    const rows = await this.rows<any>("SELECT source_id, target_id, weight, last_activated_at FROM cognitive_connections WHERE user_id = $1", [userId]);
    return rows.map((r) => ({ sourceId: r.source_id, targetId: r.target_id, weight: asNumber(r.weight), lastActivatedAt: r.last_activated_at ?? "" }));
  }

  // ── source documents + chunks ───────────────────────────────────────────

  private rowToSourceDocument(row: any): SourceDocument {
    return {
      id: row.id,
      userId: row.user_id,
      workspaceTag: row.workspace_tag ?? null,
      kind: row.kind,
      uri: row.uri ?? null,
      hash: row.hash,
      title: row.title ?? "",
      createdAt: row.created_at,
      metadata: row.metadata_json ? (typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json) : {},
    };
  }

  private rowToSourceChunk(row: any): SourceChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      ordinal: asNumber(row.ordinal),
      content: row.content,
      tokenCount: asNumber(row.token_count),
      filePath: row.file_path ?? null,
      symbol: row.symbol ?? null,
      startLine: row.start_line == null ? null : asNumber(row.start_line),
      endLine: row.end_line == null ? null : asNumber(row.end_line),
      hash: row.hash,
    };
  }

  public async getSourceDocumentByHash(userId: string, hash: string): Promise<SourceDocument | null> {
    const row = await this.one("SELECT * FROM source_documents WHERE user_id = $1 AND hash = $2 LIMIT 1", [userId, hash]);
    return row ? this.rowToSourceDocument(row) : null;
  }

  public async getSourceDocument(id: string): Promise<SourceDocument | null> {
    const row = await this.one("SELECT * FROM source_documents WHERE id = $1", [id]);
    return row ? this.rowToSourceDocument(row) : null;
  }

  public async hasFreshSourceDocument(userId: string, uri: string): Promise<boolean> {
    const row = await this.one("SELECT 1 FROM source_documents WHERE user_id = $1 AND uri = $2 AND COALESCE(stale, 0) = 0 LIMIT 1", [userId, uri]);
    return !!row;
  }

  public async setSourceDocumentChurn(documentId: string, commitCount90d: number | null, lastCommitDate: string | null): Promise<void> {
    await this.run("UPDATE source_documents SET commit_count_90d = $1, last_commit_date = $2 WHERE id = $3", [commitCount90d, lastCommitDate, documentId]);
  }

  public async getRecordsMaxChurn(userId: string, recordIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (recordIds.length === 0) return out;
    const rows = await this.rows<any>(
      `SELECT l.record_id AS rid, MAX(COALESCE(d.commit_count_90d, 0)) AS churn
         FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
         JOIN source_documents d ON d.id = sc.document_id
        WHERE l.user_id = $1 AND l.record_id = ANY($2::text[])
        GROUP BY l.record_id
        HAVING MAX(COALESCE(d.commit_count_90d, 0)) > 0`,
      [userId, recordIds],
    );
    for (const r of rows) out.set(String(r.rid), asNumber(r.churn));
    return out;
  }

  public async getSourceDocuments(userId: string, limit = 100): Promise<Array<SourceDocument & { chunkCount: number }>> {
    const rows = await this.rows<any>(
      `SELECT d.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM source_documents d WHERE d.user_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({ ...this.rowToSourceDocument(r), chunkCount: asNumber(r.chunk_count) }));
  }

  public async pruneTranscriptSources(userId: string, beforeIso: string): Promise<{ prunedDocs: number; prunedChunks: number }> {
    return this.tx(async (client) => {
      const doomed = (await client.query<{ id: string }>(
        `SELECT d.id FROM source_documents d
          WHERE d.user_id = $1 AND d.kind = 'transcript' AND d.created_at < $2
            AND NOT EXISTS (
              SELECT 1 FROM source_chunks c
              JOIN cognitive_source_links l ON l.chunk_id = c.id
              WHERE c.document_id = d.id
            )`,
        [userId, beforeIso],
      )).rows;
      if (doomed.length === 0) return { prunedDocs: 0, prunedChunks: 0 };
      let prunedChunks = 0;
      for (const { id } of doomed) {
        const res = await client.query("DELETE FROM source_chunks WHERE document_id = $1", [id]);
        prunedChunks += res.rowCount ?? 0;
        await client.query("DELETE FROM source_documents WHERE id = $1 AND user_id = $2", [id, userId]);
      }
      return { prunedDocs: doomed.length, prunedChunks };
    });
  }

  public async createSourceDocument(input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<SourceDocument> {
    const existing = await this.getSourceDocumentByHash(input.userId, input.hash);
    if (existing) return existing;
    const doc: SourceDocument = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      workspaceTag: input.workspaceTag ?? null,
      kind: input.kind,
      uri: input.uri ?? null,
      hash: input.hash,
      title: input.title ?? "",
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata,
    };
    await this.run(
      `INSERT INTO source_documents (id, user_id, workspace_tag, kind, uri, hash, title, created_at, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [doc.id, doc.userId, doc.workspaceTag, doc.kind, doc.uri, doc.hash, doc.title, doc.createdAt, JSON.stringify(doc.metadata ?? {})],
    );
    return doc;
  }

  public async lookupDocumentByPathHash(userId: string, uri: string, hash: string): Promise<{ id: string; stale: boolean } | null> {
    const row = await this.one<any>(
      `SELECT id, COALESCE(stale, 0) AS stale FROM source_documents WHERE user_id = $1 AND uri = $2 AND hash = $3 ORDER BY created_at DESC LIMIT 1`,
      [userId, uri, hash],
    );
    return row ? { id: String(row.id), stale: asNumber(row.stale) !== 0 } : null;
  }

  public async markSourceDocumentsStaleByPath(userId: string, uri: string): Promise<number> {
    return this.run("UPDATE source_documents SET stale = 1 WHERE user_id = $1 AND uri = $2 AND COALESCE(stale, 0) = 0", [userId, uri]);
  }

  public async reviveSourceDocument(documentId: string): Promise<void> {
    await this.run("UPDATE source_documents SET stale = 0 WHERE id = $1", [documentId]);
  }

  public async findImportedDocument(userId: string, candidateBase: string): Promise<SourceDocument | null> {
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
    const candidates = exts.map((e) => candidateBase + e).concat(exts.map((e) => `${candidateBase}/index${e}`));
    const row = await this.one<any>(
      `SELECT * FROM source_documents WHERE user_id = $1 AND COALESCE(stale,0)=0 AND uri = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
      [userId, candidates],
    );
    return row ? this.rowToSourceDocument(row) : null;
  }

  public async addSourceChunks(documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
    return this.tx(async (client) => {
      const startOrdinal = asNumber(
        (await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM source_chunks WHERE document_id = $1", [documentId])).rows[0]?.n,
      );
      const parent = (await client.query<{ user_id?: string; workspace_tag?: string }>(
        "SELECT user_id, workspace_tag FROM source_documents WHERE id = $1", [documentId],
      )).rows[0];
      const out: SourceChunk[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const chunk: SourceChunk = {
          id: randomUUID(),
          documentId,
          ordinal: startOrdinal + i,
          content: c.content,
          tokenCount: c.tokenCount,
          filePath: c.filePath ?? null,
          symbol: c.symbol ?? null,
          startLine: c.startLine ?? null,
          endLine: c.endLine ?? null,
          hash: createHash("sha1").update(c.content).digest("hex"),
        };
        await client.query(
          `INSERT INTO source_chunks (id, document_id, user_id, workspace_tag, ordinal, content, token_count, file_path, symbol, start_line, end_line, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [chunk.id, chunk.documentId, parent?.user_id ?? null, parent?.workspace_tag ?? null, chunk.ordinal, chunk.content, chunk.tokenCount, chunk.filePath, chunk.symbol, chunk.startLine, chunk.endLine, chunk.hash],
        );
        out.push(chunk);
      }
      const codeChunks = out.filter((c) => c.symbol);
      if (codeChunks.length >= 2) {
        const edges = extractIntraFileCallEdges(codeChunks.map((c) => ({ id: c.id, symbol: c.symbol, content: c.content })));
        for (const e of edges) {
          await client.query(
            "INSERT INTO code_symbol_edges (document_id, from_chunk_id, to_chunk_id, kind) VALUES ($1,$2,$3,'calls') ON CONFLICT DO NOTHING",
            [documentId, e.fromChunkId, e.toChunkId],
          );
        }
      }
      return out;
    });
  }

  public async getSourceChunk(id: string): Promise<SourceChunk | null> {
    const row = await this.one("SELECT * FROM source_chunks WHERE id = $1", [id]);
    return row ? this.rowToSourceChunk(row) : null;
  }

  public async getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]> {
    const rows = await this.rows("SELECT * FROM source_chunks WHERE document_id = $1 ORDER BY ordinal ASC", [documentId]);
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  public async getSourceChunkByFileLine(userId: string, filePath: string, line: number): Promise<SourceChunk | null> {
    const needle = filePath.replace(/^\.\//, "");
    const row = await this.one<any>(
      `SELECT * FROM source_chunks
        WHERE user_id = $1 AND file_path IS NOT NULL AND (file_path = $2 OR file_path LIKE $3)
          AND start_line IS NOT NULL AND end_line IS NOT NULL AND start_line <= $4 AND end_line >= $4
        ORDER BY (end_line - start_line) ASC LIMIT 1`,
      [userId, needle, `%${needle}`, line],
    );
    return row ? this.rowToSourceChunk(row) : null;
  }

  public async searchSourceChunksFts(
    userId: string,
    query: string,
    limit: number,
    opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
  ): Promise<Array<SourceChunk & { ftsRank: number }>> {
    if (!ftsHasTerms(query)) return [];
    // Code search seeds from a chunk's identifier bag, where ANY shared token is
    // a useful neighbour — match with OR semantics (FTS5 parity), not the AND of
    // `plainto_tsquery`. Without this a camelCase seed (`parseConfig`, stored as
    // the single lexeme `parseconfig`) never matches a split `parse & config`
    // query. `orTsQuery` restricts tokens to `[\p{L}\p{N}_]`, so the body is a
    // safe `to_tsquery` input. `english` config keeps consistency with the
    // generated `content_tsv` column (migration 002) so the GIN index applies.
    const tsq = orTsQuery(query);
    if (!tsq) return [];
    const cap = Math.max(1, Math.min(200, limit));
    const fetch = Math.min(200, cap * 4);
    // Generated content_tsv covers content + symbol (migration 002). Rank with
    // ts_rank; the SQLite path uses FTS5 `rank` ascending — here higher ts_rank
    // is better, and the code reranker (MEM-26/27) refines either way.
    const rows = await this.rows<any>(
      `SELECT sc.*, ts_rank(sc.content_tsv, to_tsquery('english', $2)) AS fts_rank
         FROM source_chunks sc
         JOIN source_documents d ON d.id = sc.document_id
        WHERE sc.user_id = $1 AND sc.content_tsv @@ to_tsquery('english', $2) AND COALESCE(d.stale, 0) = 0
        ORDER BY fts_rank DESC
        LIMIT $3`,
      [userId, tsq, fetch],
    );
    const exts = opts?.filePathLike;
    const out: Array<SourceChunk & { ftsRank: number }> = [];
    for (const r of rows) {
      if (opts?.excludeChunkId && r.id === opts.excludeChunkId) continue;
      if (opts?.excludeDocumentId && r.document_id === opts.excludeDocumentId) continue;
      if (exts && exts.length > 0) {
        const fp: string = r.file_path ?? "";
        if (!exts.some((e) => fp.endsWith(e))) continue;
      }
      out.push({ ...this.rowToSourceChunk(r), ftsRank: asNumber(r.fts_rank) });
      if (out.length >= cap) break;
    }
    return out;
  }

  public async isSourceDocumentReferenced(documentId: string): Promise<boolean> {
    const row = await this.one(
      "SELECT 1 FROM source_chunks c JOIN cognitive_source_links l ON l.chunk_id = c.id WHERE c.document_id = $1 LIMIT 1",
      [documentId],
    );
    return !!row;
  }

  public async replaceSourceChunks(documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
    await this.tx(async (client) => {
      await client.query("DELETE FROM code_symbol_edges WHERE document_id = $1", [documentId]);
      await client.query("DELETE FROM source_chunks WHERE document_id = $1", [documentId]);
    });
    return this.addSourceChunks(documentId, chunks);
  }

  public async getCodeEdgeNeighbors(userId: string, chunkId: string, direction: "callees" | "callers"): Promise<SourceChunk[]> {
    const col = direction === "callees" ? "from_chunk_id" : "to_chunk_id";
    const other = direction === "callees" ? "to_chunk_id" : "from_chunk_id";
    const rows = await this.rows<any>(
      `SELECT sc.* FROM code_symbol_edges e
         JOIN source_chunks sc ON sc.id = e.${other}
        WHERE e.${col} = $1 AND (sc.user_id = $2 OR sc.user_id IS NULL)`,
      [chunkId, userId],
    );
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  public async linkRecordSources(userId: string, recordId: string, chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const now = new Date().toISOString();
    await this.tx(async (client) => {
      for (const chunkId of chunkIds) {
        await client.query(
          "INSERT INTO cognitive_source_links (user_id, record_id, chunk_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id, chunk_id) DO NOTHING",
          [userId, recordId, chunkId, now],
        );
      }
    });
  }

  public async getStorageGovernanceStats(userId: string): Promise<{
    sourceDocuments: number;
    sourceChunks: { count: number; chars: number; orphanCount: number; orphanChars: number };
    treeNodes: { count: number; chars: number };
    vaultExports: number;
  }> {
    const docs = await this.one<{ n: string }>("SELECT COUNT(*) AS n FROM source_documents WHERE user_id = $1", [userId]);
    const chunks = await this.one<{ n: string; chars: string }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM source_chunks WHERE user_id = $1", [userId]);
    const orphans = await this.one<{ n: string; chars: string }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars
         FROM source_chunks
        WHERE user_id = $1 AND id NOT IN (SELECT chunk_id FROM cognitive_source_links WHERE user_id = $1)`,
      [userId],
    );
    const tree = await this.one<{ n: string; chars: string }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(summary_md)), 0) AS chars FROM memory_tree_nodes WHERE user_id = $1", [userId]);
    const vault = await this.one<{ n: string }>("SELECT COUNT(*) AS n FROM vault_exports WHERE user_id = $1", [userId]);
    return {
      sourceDocuments: asNumber(docs?.n),
      sourceChunks: { count: asNumber(chunks?.n), chars: asNumber(chunks?.chars), orphanCount: asNumber(orphans?.n), orphanChars: asNumber(orphans?.chars) },
      treeNodes: { count: asNumber(tree?.n), chars: asNumber(tree?.chars) },
      vaultExports: asNumber(vault?.n),
    };
  }

  public async getRecordSourceChunks(userId: string, recordId: string): Promise<SourceChunk[]> {
    const rows = await this.rows<any>(
      `SELECT sc.* FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
        WHERE l.record_id = $1 AND l.user_id = $2
        ORDER BY sc.document_id ASC, sc.ordinal ASC`,
      [recordId, userId],
    );
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  public async isRecordSourceStale(userId: string, recordId: string): Promise<boolean> {
    const row = await this.one(
      `SELECT 1 FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
         JOIN source_documents d ON d.id = sc.document_id
        WHERE l.record_id = $1 AND l.user_id = $2 AND COALESCE(d.stale, 0) = 1 LIMIT 1`,
      [recordId, userId],
    );
    return !!row;
  }

  // ── blackboard ─────────────────────────────────────────────────────────

  private rowToBlackboardItem(row: any): BlackboardItem {
    return {
      id: row.id,
      userId: row.user_id,
      sourceChunkId: row.source_chunk_id ?? null,
      candidate: typeof row.candidate_json === "string" ? JSON.parse(row.candidate_json) : row.candidate_json,
      score: asNumber(row.score),
      status: row.status,
      conflictIds: row.conflict_ids_json ? (typeof row.conflict_ids_json === "string" ? JSON.parse(row.conflict_ids_json) : row.conflict_ids_json) : [],
      createdAt: row.created_at,
      committedRecordId: row.committed_record_id ?? null,
    };
  }

  public async stageBlackboardItems(userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]> {
    const now = new Date().toISOString();
    const staged: BlackboardItem[] = [];
    await this.tx(async (client) => {
      for (const input of items) {
        const id = `bb_${randomUUID()}`;
        await client.query(
          `INSERT INTO memory_blackboard_items (id, user_id, source_chunk_id, candidate_json, score, status, conflict_ids_json, created_at, committed_record_id)
           VALUES ($1,$2,$3,$4,$5,'pending','[]',$6,NULL)`,
          [id, userId, input.sourceChunkId ?? null, JSON.stringify(input.candidate), input.score ?? 0, now],
        );
        staged.push({
          id, userId, sourceChunkId: input.sourceChunkId ?? null, candidate: input.candidate,
          score: input.score ?? 0, status: "pending", conflictIds: [], createdAt: now, committedRecordId: null,
        });
      }
    });
    return staged;
  }

  public async getBlackboardItem(id: string): Promise<BlackboardItem | null> {
    const row = await this.one("SELECT * FROM memory_blackboard_items WHERE id = $1 LIMIT 1", [id]);
    return row ? this.rowToBlackboardItem(row) : null;
  }

  public async getBlackboardItems(userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]> {
    const rows = status
      ? await this.rows("SELECT * FROM memory_blackboard_items WHERE user_id = $1 AND status = $2 ORDER BY score DESC, created_at ASC", [userId, status])
      : await this.rows("SELECT * FROM memory_blackboard_items WHERE user_id = $1 ORDER BY created_at ASC", [userId]);
    return rows.map((r) => this.rowToBlackboardItem(r));
  }

  public async updateBlackboardItem(
    id: string,
    patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.score !== undefined) { sets.push("score = ?"); vals.push(patch.score); }
    if (patch.conflictIds !== undefined) { sets.push("conflict_ids_json = ?"); vals.push(JSON.stringify(patch.conflictIds)); }
    if (patch.committedRecordId !== undefined) { sets.push("committed_record_id = ?"); vals.push(patch.committedRecordId); }
    if (sets.length === 0) return;
    vals.push(id);
    await this.run(pg(`UPDATE memory_blackboard_items SET ${sets.join(", ")} WHERE id = ?`), vals);
  }

  // ── memory tree ─────────────────────────────────────────────────────────

  private rowToTreeNode(row: any): MemoryTreeNode {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      parentId: row.parent_id ?? null,
      level: asNumber(row.level),
      summaryMd: row.summary_md ?? "",
      sourceChunkIds: row.source_chunk_ids_json ? (typeof row.source_chunk_ids_json === "string" ? JSON.parse(row.source_chunk_ids_json) : row.source_chunk_ids_json) : [],
      sealedAt: row.sealed_at ?? null,
      heatScore: asNumber(row.heat_score),
      createdAt: row.created_at,
    };
  }

  public async getTreeNodeIdByChunkId(userId: string, chunkId: string): Promise<string | null> {
    const needle = `%"${chunkId.replace(/[\\%_]/g, (c) => "\\" + c)}"%`;
    // `seq DESC` is the faithful analogue of SQLite's `rowid DESC` tiebreak: on
    // a created_at tie (same-millisecond appends) it deterministically returns
    // the newest covering node rather than an arbitrary heap-ordered row.
    const row = await this.one<{ id: string }>(
      `SELECT id FROM memory_tree_nodes
        WHERE user_id = $1 AND source_chunk_ids_json LIKE $2 ESCAPE '\\'
        ORDER BY created_at DESC, seq DESC LIMIT 1`,
      [userId, needle],
    );
    return row?.id ?? null;
  }

  public async appendTreeNode(userId: string, input: MemoryTreeNodeInput): Promise<MemoryTreeNode> {
    const node: MemoryTreeNode = {
      id: `tree_${randomUUID()}`,
      userId,
      kind: input.kind,
      parentId: input.parentId ?? null,
      level: input.level ?? 0,
      summaryMd: input.summaryMd,
      sourceChunkIds: input.sourceChunkIds ?? [],
      sealedAt: null,
      heatScore: input.heatScore ?? 0,
      createdAt: new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO memory_tree_nodes (id, user_id, kind, parent_id, level, summary_md, source_chunk_ids_json, sealed_at, heat_score, created_at, scene_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10)`,
      [node.id, userId, node.kind, node.parentId, node.level, node.summaryMd, JSON.stringify(node.sourceChunkIds), node.heatScore, node.createdAt, input.sceneKey ?? null],
    );
    return node;
  }

  public async getDistinctScenes(userId: string): Promise<Array<{ sceneName: string; recordCount: number }>> {
    const rows = await this.rows<{ scenename: string; recordcount: string }>(
      `SELECT scene_name AS sceneName, COUNT(*) AS recordCount
         FROM cognitive_records
        WHERE user_id = $1 AND archived = 0 AND scene_name IS NOT NULL AND scene_name != ''
        GROUP BY scene_name
        ORDER BY recordCount DESC`,
      [userId],
    );
    // pg lowercases unquoted output aliases; read either casing safely.
    return rows.map((r: any) => ({ sceneName: r.scenename ?? r.sceneName, recordCount: asNumber(r.recordcount ?? r.recordCount) }));
  }

  public async getSceneLeafKeys(userId: string): Promise<string[]> {
    const rows = await this.rows<{ scene_key: string }>(
      "SELECT DISTINCT scene_key FROM memory_tree_nodes WHERE user_id = $1 AND scene_key IS NOT NULL",
      [userId],
    );
    return rows.map((r) => r.scene_key);
  }

  public async getSceneRecordContents(userId: string, sceneName: string, limit = 8): Promise<string[]> {
    const rows = await this.rows<{ content: string }>(
      "SELECT content FROM cognitive_records WHERE user_id = $1 AND scene_name = $2 AND archived = 0 ORDER BY created_time DESC LIMIT $3",
      [userId, sceneName, limit],
    );
    return rows.map((r) => r.content);
  }

  public async getUnsealedSceneLeaves(userId: string, limit = 50): Promise<MemoryTreeNode[]> {
    const rows = await this.rows<any>(
      `SELECT * FROM memory_tree_nodes
        WHERE user_id = $1 AND scene_key IS NOT NULL AND level = 0 AND sealed_at IS NULL AND parent_id IS NULL
        ORDER BY created_at ASC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => this.rowToTreeNode(r));
  }

  public async getTreeNode(id: string): Promise<MemoryTreeNode | null> {
    const row = await this.one("SELECT * FROM memory_tree_nodes WHERE id = $1 LIMIT 1", [id]);
    return row ? this.rowToTreeNode(row) : null;
  }

  public async getTreeChildren(parentId: string): Promise<MemoryTreeNode[]> {
    const rows = await this.rows("SELECT * FROM memory_tree_nodes WHERE parent_id = $1 ORDER BY created_at ASC", [parentId]);
    return rows.map((r) => this.rowToTreeNode(r));
  }

  public async getTreeRoots(userId: string, kind?: MemoryTreeKind): Promise<MemoryTreeNode[]> {
    const rows = kind
      ? await this.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 AND parent_id IS NULL AND kind = $2 ORDER BY heat_score DESC, created_at ASC", [userId, kind])
      : await this.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 AND parent_id IS NULL ORDER BY heat_score DESC, created_at ASC", [userId]);
    return rows.map((r) => this.rowToTreeNode(r));
  }

  public async setTreeParent(childIds: string[], parentId: string): Promise<void> {
    if (childIds.length === 0) return;
    await this.run("UPDATE memory_tree_nodes SET parent_id = $1 WHERE id = ANY($2::text[])", [parentId, childIds]);
  }

  public async sealTreeNode(id: string): Promise<void> {
    await this.run("UPDATE memory_tree_nodes SET sealed_at = $1 WHERE id = $2 AND sealed_at IS NULL", [new Date().toISOString(), id]);
  }

  public async updateTreeNodeSummary(id: string, summaryMd: string): Promise<void> {
    await this.run("UPDATE memory_tree_nodes SET summary_md = $1 WHERE id = $2", [summaryMd, id]);
  }

  public async getAllTreeNodes(userId: string): Promise<MemoryTreeNode[]> {
    const rows = await this.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 ORDER BY level ASC, created_at ASC", [userId]);
    return rows.map((r) => this.rowToTreeNode(r));
  }

  // ── vault export ledger ──────────────────────────────────────────────────

  public async upsertVaultExport(userId: string, input: VaultExportInput): Promise<void> {
    await this.run(
      `INSERT INTO vault_exports (user_id, path, hash, kind, ref_id, exported_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, path) DO UPDATE SET hash = EXCLUDED.hash, kind = EXCLUDED.kind, ref_id = EXCLUDED.ref_id, exported_at = EXCLUDED.exported_at`,
      [userId, input.path, input.hash, input.kind, input.refId, new Date().toISOString()],
    );
  }

  public async getVaultExports(userId: string): Promise<VaultExportEntry[]> {
    const rows = await this.rows<any>("SELECT * FROM vault_exports WHERE user_id = $1 ORDER BY path ASC", [userId]);
    return rows.map((r) => ({ userId: r.user_id, path: r.path, hash: r.hash, kind: r.kind, refId: r.ref_id, exportedAt: r.exported_at }));
  }
}
