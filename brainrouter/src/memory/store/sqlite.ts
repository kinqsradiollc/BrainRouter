import { DatabaseSync, StatementSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import type { ActiveSessionFilters, ActiveSessionRecord, ActiveSessionUsage, SessionInboxFilters, SessionInboxKind, SessionInboxRecord, PendingDelegationRecord, PendingDelegationEnqueueInput, PendingDelegationFilters, PendingDelegationStatus, DelegationPacket, MemoryJobRecord, MemoryJobStatus, MemoryJobEnqueueInput, MemoryJobListFilters, MemoryJobKindAggregate, ContradictionRecord, CursorPaginationOptions, EvidenceListFilters, ExtractionStatus, ImportResult, SensoryRecord, CognitiveRecord, CognitiveFtsResult, MemoryEvidence, MemoryExport, MemoryImport, MemoryListFilters, MemoryListItem, MemoryOperation, MemoryStatus, OperationLogFilters, VectorSearchResult, SkillActivationRecord, SkillHintsRecord, ContextualFocusRecord, CoreIdentityRecord, SchedulerState, GraphNode, GraphEdge, StalledExtractionBacklog, UserRecord, SourceDocument, SourceChunk, SourceChunkInput, BlackboardItem, BlackboardItemInput, BlackboardStatus, MemoryTreeNode, MemoryTreeNodeInput, MemoryTreeKind, VaultExportEntry, VaultExportInput } from "@kinqs/brainrouter-types";
import * as sqliteVec from "sqlite-vec";
import type { IMemoryStore } from "@kinqs/brainrouter-types";

// Ensure Node version has node:sqlite (v22+)
const DB_VERSION_ERROR = "Memory Engine requires Node.js v22+ with node:sqlite built-in.";

// A minimal BM25 search ranking helper (for simple text split)
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

function buildFtsQuery(raw: string): string | null {
  // Simple Unicode regex split for English + general tokens
  const tokens = raw
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((t) => t.trim())
    .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function cognitiveRowToRecord(row: any): CognitiveRecord {
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

function evidenceRowToRecord(row: any): MemoryEvidence {
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

function activeSessionRowToRecord(row: any, includeUsage: boolean): ActiveSessionRecord {
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

function inboxRowToRecord(row: {
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

function jobRowToRecord(row: {
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

const JOB_COLUMNS =
  "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at";

function operationRowToRecord(row: any): MemoryOperation {
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

export class SqliteMemoryStore implements IMemoryStore {
  private db: DatabaseSync;

  // Sensory statements
  private stmtSensoryUpsertMeta!: StatementSync;
  private stmtSensoryQueryAfter!: StatementSync;

  // Cognitive statements
  private stmtCognitiveUpsertMeta!: StatementSync;
  private stmtCognitiveGetMeta!: StatementSync;
  
  // FTS statements
  private stmtCognitiveFtsInsert!: StatementSync;
  private stmtCognitiveFtsSearch!: StatementSync;

  // Vector statements
  private stmtCognitiveVecInsert?: StatementSync;
  private stmtCognitiveVecDelete?: StatementSync;

  private vecLoaded = false;
  private vecDimensions = 0;

  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath, { allowExtension: true });
    } catch (e) {
      throw new Error(`${DB_VERSION_ERROR}\n${e}`);
    }

    this.db.exec("PRAGMA busy_timeout = 5000");

    // WAL is required by 0.4.0 federation — multiple MCP-aware CLIs share
    // one db and need concurrent reads + a single writer. Without WAL,
    // parallel writes serialize and a long extraction blocks every peer's
    // recall. SQLite can silently refuse WAL on some filesystems
    // (network shares, certain tmpfs configurations), so we set it AND
    // read back the effective mode and warn if it didn't take. We don't
    // throw — a single-client install on an exotic FS should still boot
    // — but the federation hardening guarantees only hold when this
    // resolves to `wal`.
    this.db.exec("PRAGMA journal_mode = WAL");
    const mode = this.getJournalMode();
    if (mode.toLowerCase() !== "wal") {
      console.error(
        `[BrainRouter] WARNING: SQLite journal_mode resolved to '${mode}', not 'wal'. ` +
          `Federation concurrency guarantees do not hold. ` +
          `Check the underlying filesystem (network mounts and certain tmpfs configurations refuse WAL).`,
      );
    }
  }

  /**
   * Returns the effective `journal_mode` PRAGMA. Federation depends on
   * this being `wal`; the constructor warns when it isn't, but callers
   * (and tests) may want to assert it directly.
   */
  public getJournalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    return row?.journal_mode ?? "unknown";
  }

  public init() {
    this.initSchema();
  }

  public initVec(dimensions: number) {
    if (dimensions <= 0) return;
    
    try {
      sqliteVec.load(this.db);
      this.vecLoaded = true;
    } catch (e) {
      console.error("[BrainRouter] Failed to load sqlite-vec. Vector search disabled.", e);
      return;
    }

    this.vecDimensions = dimensions;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Robust dimension check: extract actual dimension from the virtual table schema
    const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cognitive_vec'").get() as any;
    let actualDimensions = -1;
    if (tableInfo && tableInfo.sql) {
      const match = tableInfo.sql.match(/float\[(\d+)\]/i);
      if (match) actualDimensions = parseInt(match[1], 10);
    }

    if (actualDimensions !== -1 && actualDimensions !== dimensions) {
      console.error(`[BrainRouter] Embedding dimensions changed (${actualDimensions} -> ${dimensions}). Recreating vector tables.`);
      try {
        this.db.exec("DROP TABLE IF EXISTS cognitive_vec");
      } catch (e) {
        console.warn("[BrainRouter] Error dropping cognitive_vec:", e);
      }
      this.db.prepare("UPDATE embedding_meta SET dimensions = ?, created_at = ? WHERE id = 1")
        .run(dimensions, new Date().toISOString());
    } else {
      const metaRow = this.db.prepare("SELECT dimensions FROM embedding_meta WHERE id = 1").get() as any;
      if (!metaRow) {
        this.db.prepare("INSERT INTO embedding_meta (id, dimensions, created_at) VALUES (1, ?, ?)")
          .run(dimensions, new Date().toISOString());
      }
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS cognitive_vec USING vec0(
        record_id TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      )
    `);

    this.stmtCognitiveVecInsert = this.db.prepare("INSERT INTO cognitive_vec (record_id, embedding) VALUES (?, ?)");
    this.stmtCognitiveVecDelete = this.db.prepare("DELETE FROM cognitive_vec WHERE record_id = ?");
  }

  public isVecAvailable(): boolean {
    return this.vecLoaded && this.vecDimensions > 0;
  }

  public async reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number> {
    if (!this.vecLoaded) return 0;

    const rows = this.db.prepare(`
      SELECT r.record_id, r.content
      FROM cognitive_records r
      LEFT JOIN cognitive_vec v ON r.record_id = v.record_id
      WHERE r.invalid_at IS NULL
        AND r.archived = 0
        AND v.record_id IS NULL
      ORDER BY r.created_time ASC, r.record_id ASC
    `).all() as Array<{ record_id: string; content: string }>;

    let successCount = 0;
    for (const row of rows) {
      try {
        const embedding = await embedder(row.content);
        this.upsertCognitiveVec(row.record_id, embedding);
        successCount += 1;
      } catch (error) {
        console.error(
          `[BrainRouter] Failed to re-embed record ${row.record_id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return successCount;
  }

  public getSqliteVersion(): string {
    try {
      const row = this.db.prepare("SELECT sqlite_version() AS version").get() as { version?: string } | undefined;
      return row?.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private initSchema() {
    // ── Sensory Schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sensory_stream (
        record_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0,
        skill_tag TEXT DEFAULT '',
        extracted_at TEXT DEFAULT NULL
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sensory_user_session ON sensory_stream(user_id, session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sensory_recorded ON sensory_stream(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sensory_extracted ON sensory_stream(user_id, session_key, extracted_at)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        api_key TEXT NOT NULL UNIQUE,
        password_hash TEXT DEFAULT NULL,
        display_name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        is_admin INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL
      )
    `);

    // Federation Stage 2 (0.4.0) — active-session registry. Composite
    // PK on `(session_key, user_id)` prevents a misbehaving client
    // from accidentally stomping another user's session if it reuses
    // the same key. `usage_json` is NULL when the client doesn't
    // report telemetry (FED-S2-T8).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        session_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_kind TEXT NOT NULL DEFAULT 'http-unknown',
        workspace_root TEXT DEFAULT '',
        started_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}',
        usage_json TEXT DEFAULT NULL,
        PRIMARY KEY (session_key, user_id)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_active_sessions_user_heartbeat ON active_sessions(user_id, last_heartbeat_at DESC)",
    );

    // Federation Stage 3 (0.4.0) — cross-CLI inbox. Per-recipient row;
    // broadcasts are fanned out at send time so each recipient sees a
    // distinct id and acks independently. Indexed by recipient + read
    // order so `session_inbox_read` is O(log N + page).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_inbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        from_session_key TEXT NOT NULL,
        to_session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        delivered_at TEXT DEFAULT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_inbox_recipient ON session_inbox(user_id, to_session_key, created_at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_inbox_delivered ON session_inbox(delivered_at)",
    );

    // Federation Stage 5 (0.4.2) — FED-S5-T2 fallback queue for
    // cross-vendor delegations that had no idle peer at send time.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_delegations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        from_session_key TEXT NOT NULL,
        to_agent_kind TEXT NOT NULL,
        to_session_key TEXT DEFAULT NULL,
        packet_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT DEFAULT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_delegations_claimable ON pending_delegations(user_id, to_agent_kind, status, created_at)",
    );

    // BRAIN-P1 (0.4.1) — brain-agent job queue (BRAIN-DESIGN-T2).
    // Global to the brain instance (single-tenant per API key — OQ-3);
    // per-user routing lives in input_json, never a column. Every
    // brain-side action becomes a row so it is observable + retryable.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 50,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after TEXT NOT NULL,
        locked_at TEXT,
        parent_job_id TEXT,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_jobs_eligible
         ON memory_jobs(status, priority DESC, run_after)
         WHERE status = 'pending'`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_jobs_running
         ON memory_jobs(locked_at) WHERE locked_at IS NOT NULL`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_jobs_kind ON memory_jobs(kind, updated_at)",
    );

    this.stmtSensoryUpsertMeta = this.db.prepare(`
      INSERT INTO sensory_stream (
        record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp
    `);

    this.stmtSensoryQueryAfter = this.db.prepare(`
      SELECT record_id as id, user_id as userId, session_key as sessionKey, session_id as sessionId,
             role, message_text as messageText, recorded_at as recordedAt, timestamp, skill_tag as skillTag
      FROM sensory_stream
      WHERE user_id = ? AND session_key = ? AND recorded_at > ? AND extracted_at IS NULL
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    // ── Cognitive Schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cognitive_records (
        record_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        skill_tag TEXT DEFAULT '',
        half_life_days INTEGER,
        superseded_by TEXT,
        invalid_at TEXT DEFAULT NULL,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        citation_count INTEGER DEFAULT 0,
        last_cited_at TEXT,
        never_cited_count INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0.65,
        status TEXT DEFAULT 'active',
        source_kind TEXT DEFAULT '',
        verification_status TEXT DEFAULT '',
        repo_paths_json TEXT DEFAULT '[]',
        file_paths_json TEXT DEFAULT '[]',
        commands_json TEXT DEFAULT '[]',
        workspace_tag TEXT,
        project_tag TEXT
      )
    `);

    // Federation Stage 1 (0.4.0) — add `workspace_tag` to existing
    // databases that pre-date the column. SQLite's ADD COLUMN is
    // idempotent only via try/catch; we swallow the "duplicate column"
    // error so a brain that's been upgraded once doesn't crash on
    // subsequent boots. Existing rows pick up NULL, which the recall
    // filter treats as "tag unknown — surface in every workspace".
    try {
      this.db.exec("ALTER TABLE cognitive_records ADD COLUMN workspace_tag TEXT");
    } catch (e) {
      const msg = (e as Error).message || "";
      if (!/duplicate column name/i.test(msg)) throw e;
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_workspace_tag ON cognitive_records(user_id, workspace_tag)");

    // AUG-A1 (0.4.1) — same idempotent migration for `project_tag`.
    try {
      this.db.exec("ALTER TABLE cognitive_records ADD COLUMN project_tag TEXT");
    } catch (e) {
      const msg = (e as Error).message || "";
      if (!/duplicate column name/i.test(msg)) throw e;
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_project_tag ON cognitive_records(user_id, project_tag)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        excerpt TEXT DEFAULT '',
        observed_at TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}'
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_evidence_record ON memory_evidence(user_id, record_id)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_operations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_id TEXT DEFAULT NULL,
        operation TEXT NOT NULL,
        actor TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}'
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_operations_user_time ON memory_operations(user_id, created_at DESC, id ASC)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_file_index (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        symbol TEXT DEFAULT '',
        created_time TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_file_index_path ON memory_file_index(user_id, file_path, created_time DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_file_index_record ON memory_file_index(user_id, record_id)");

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_user_type ON cognitive_records(user_id, type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_user_session ON cognitive_records(user_id, session_key)");

    this.stmtCognitiveUpsertMeta = this.db.prepare(`
      INSERT INTO cognitive_records (
        record_id, user_id, session_key, session_id, content, type, priority, scene_name, skill_tag,
        half_life_days, superseded_by, invalid_at, timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json, confidence, status, source_kind, verification_status,
        repo_paths_json, file_paths_json, commands_json, workspace_tag, project_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        skill_tag=excluded.skill_tag,
        half_life_days=excluded.half_life_days,
        superseded_by=excluded.superseded_by,
        invalid_at=excluded.invalid_at,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        confidence=excluded.confidence,
        status=excluded.status,
        source_kind=excluded.source_kind,
        verification_status=excluded.verification_status,
        repo_paths_json=excluded.repo_paths_json,
        file_paths_json=excluded.file_paths_json,
        commands_json=excluded.commands_json,
        workspace_tag=COALESCE(excluded.workspace_tag, cognitive_records.workspace_tag),
        project_tag=COALESCE(excluded.project_tag, cognitive_records.project_tag)
    `);

    this.stmtCognitiveGetMeta = this.db.prepare(`
      SELECT * FROM cognitive_records WHERE record_id = ? AND user_id = ?
    `);

    // ── Cognitive FTS5 Schema ──
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS cognitive_fts USING fts5(
        content,
        content_original UNINDEXED,
        record_id UNINDEXED,
        user_id UNINDEXED,
        type UNINDEXED,
        priority UNINDEXED,
        scene_name UNINDEXED,
        skill_tag UNINDEXED,
        session_key UNINDEXED,
        timestamp_str UNINDEXED,
        created_time UNINDEXED
      )
    `);

    this.stmtCognitiveFtsInsert = this.db.prepare(`
      INSERT INTO cognitive_fts (
        content, content_original, record_id, user_id, type, priority, scene_name,
        skill_tag, session_key, timestamp_str, created_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtCognitiveFtsSearch = this.db.prepare(`
      SELECT 
        f.record_id, f.user_id, f.content_original as content, f.type, f.priority, f.scene_name,
        f.skill_tag, f.session_key, f.timestamp_str, f.created_time,
        f.rank, r.citation_count
      FROM cognitive_fts f
      JOIN cognitive_records r ON f.record_id = r.record_id
      WHERE f.user_id = ? AND cognitive_fts MATCH ? AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY rank
      LIMIT ?
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_id_a TEXT NOT NULL,
        record_id_b TEXT NOT NULL,
        reason TEXT,
        confidence REAL,
        status TEXT DEFAULT 'pending', -- pending, resolved, dismissed
        created_time TEXT DEFAULT ''
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_user ON contradictions(user_id, status)");

    // ── Skill Extraction Hints Schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_extraction_hints (
        skill_name TEXT PRIMARY KEY,
        hints TEXT NOT NULL,
        source_file TEXT DEFAULT '',
        registered_at TEXT DEFAULT ''
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_activations (
        user_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        potential REAL DEFAULT 0.0,
        last_decay_time TEXT NOT NULL,
        PRIMARY KEY (user_id, skill_name)
      )
    `);

    // ── Contextual Focus Scenes ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contextual_focus (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        scene_name TEXT NOT NULL,
        summary_md TEXT NOT NULL,
        heat_score REAL DEFAULT 100.0,
        last_active_time TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        UNIQUE(user_id, scene_name)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_focus_user_heat ON contextual_focus(user_id, heat_score DESC)");

    // ── Core Identity ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_identity (
        user_id TEXT PRIMARY KEY,
        persona_md TEXT NOT NULL,
        cognitive_count_at_generation INTEGER DEFAULT 0,
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT ''
      )
    `);

    // ── Scheduler State ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        user_id TEXT PRIMARY KEY,
        cognitive_count_since_last_focus INTEGER DEFAULT 0,
        cognitive_count_since_last_identity INTEGER DEFAULT 0,
        total_cognitive_count INTEGER DEFAULT 0,
        extraction_errors INTEGER DEFAULT 0,
        last_error_message TEXT DEFAULT NULL,
        last_error_at TEXT DEFAULT NULL
      )
    `);

    // ── GraphRAG Nodes ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        skill_tag TEXT DEFAULT '',
        confidence REAL DEFAULT 1.0,
        source_record_id TEXT,
        created_time TEXT DEFAULT '',
        UNIQUE(user_id, entity)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_user ON graph_nodes(user_id)");

    // ── GraphRAG Edges ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        skill_tag TEXT DEFAULT '',
        confidence REAL DEFAULT 1.0,
        source_record_id TEXT,
        created_time TEXT DEFAULT '',
        UNIQUE(user_id, from_node_id, to_node_id, relation)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id)");

    // ── Dendritic Spines (Cognitive Connections) ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cognitive_connections (
        user_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        weight REAL DEFAULT 0.5,
        last_activated_at TEXT DEFAULT '',
        PRIMARY KEY (user_id, source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_conn_user_src ON cognitive_connections(user_id, source_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cognitive_conn_user_tgt ON cognitive_connections(user_id, target_id)");

    // 0.4.3 Brain Phase 2/3 — source documents + token-aware chunks. Additive
    // tables: every extracted cognitive record will cite chunk ids. user_id +
    // workspace_tag are present now so team/RBAC can arrive without migration;
    // `hash` makes re-ingest of the same source idempotent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_documents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_tag TEXT DEFAULT NULL,
        kind TEXT NOT NULL,
        uri TEXT DEFAULT NULL,
        hash TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_docs_user_hash ON source_documents(user_id, hash)");
    // 0.4.3 — the /sources view + transcript retention both query newest-first
    // per user; without this index that's a filesort once transcripts pile up.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_docs_user_created ON source_documents(user_id, created_at)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        user_id TEXT DEFAULT NULL,
        workspace_tag TEXT DEFAULT NULL,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        file_path TEXT DEFAULT NULL,
        symbol TEXT DEFAULT NULL,
        start_line INTEGER DEFAULT NULL,
        end_line INTEGER DEFAULT NULL,
        hash TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES source_documents(id) ON DELETE CASCADE
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_chunks_doc ON source_chunks(document_id, ordinal)");
    // MEM-3 — batch-level provenance: which source chunks a cognitive record
    // was distilled from. user_id carried for RBAC-readiness (MEM-14).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cognitive_source_links (
        user_id TEXT NOT NULL,
        workspace_tag TEXT DEFAULT NULL,
        record_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, chunk_id),
        FOREIGN KEY (chunk_id) REFERENCES source_chunks(id) ON DELETE CASCADE
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cog_source_links_record ON cognitive_source_links(record_id)");
    // MEM-4 — blackboard: extracted candidates staged here before committing to
    // cognitive records. user_id for RBAC-readiness (MEM-14).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_blackboard_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_tag TEXT DEFAULT NULL,
        source_chunk_id TEXT DEFAULT NULL,
        candidate_json TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        conflict_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        committed_record_id TEXT DEFAULT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_user_status ON memory_blackboard_items(user_id, status)");
    // MEM-5 — durable hierarchical summary tree (source/topic/global). user_id
    // for RBAC-readiness (MEM-14). level 0 = leaf.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_tree_nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_tag TEXT DEFAULT NULL,
        kind TEXT NOT NULL,
        parent_id TEXT DEFAULT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        summary_md TEXT NOT NULL DEFAULT '',
        source_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
        sealed_at TEXT DEFAULT NULL,
        heat_score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tree_user_kind ON memory_tree_nodes(user_id, kind, parent_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tree_parent ON memory_tree_nodes(parent_id)");
    // MEM-7 — vault export ledger (path → content hash) for idempotent re-export.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_exports (
        user_id TEXT NOT NULL,
        workspace_tag TEXT DEFAULT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        exported_at TEXT NOT NULL,
        PRIMARY KEY (user_id, path)
      )
    `);
    // MEM-14 — RBAC-ready schema. The CREATE statements above carry user_id +
    // workspace_tag on fresh DBs; for DBs created earlier in 0.4.3 dev, add the
    // columns idempotently so every new table is scope-ready without a future
    // migration. Local-first: columns stay NULL until federation populates them.
    this.ensureColumn("source_chunks", "user_id", "TEXT DEFAULT NULL");
    this.ensureColumn("source_chunks", "workspace_tag", "TEXT DEFAULT NULL");
    this.ensureColumn("cognitive_source_links", "workspace_tag", "TEXT DEFAULT NULL");
    this.ensureColumn("memory_blackboard_items", "workspace_tag", "TEXT DEFAULT NULL");
    this.ensureColumn("memory_tree_nodes", "workspace_tag", "TEXT DEFAULT NULL");
    // 0.4.3 (MEM-10) — the cognitive scene a scene-derived leaf summarizes; lets
    // the tree autobuilder keep one leaf per scene without a content scan.
    this.ensureColumn("memory_tree_nodes", "scene_key", "TEXT DEFAULT NULL");
    this.ensureColumn("vault_exports", "workspace_tag", "TEXT DEFAULT NULL");
  }

  /** MEM-14 — idempotently add a column to a table (no-op if it already exists). */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ============================
  // Source Documents & Chunks (0.4.3 Brain Phase 2/3)
  // ============================

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
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    };
  }

  private rowToSourceChunk(row: any): SourceChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      content: row.content,
      tokenCount: row.token_count,
      filePath: row.file_path ?? null,
      symbol: row.symbol ?? null,
      startLine: row.start_line ?? null,
      endLine: row.end_line ?? null,
      hash: row.hash,
    };
  }

  public getSourceDocumentByHash(userId: string, hash: string): SourceDocument | null {
    const row = this.db.prepare("SELECT * FROM source_documents WHERE user_id = ? AND hash = ? LIMIT 1").get(userId, hash) as any;
    return row ? this.rowToSourceDocument(row) : null;
  }

  public getSourceDocument(id: string): SourceDocument | null {
    const row = this.db.prepare("SELECT * FROM source_documents WHERE id = ?").get(id) as any;
    return row ? this.rowToSourceDocument(row) : null;
  }

  /** List a user's source documents (newest first) + their chunk counts — powers the dashboard Sources view. */
  public getSourceDocuments(userId: string, limit = 100): Array<SourceDocument & { chunkCount: number }> {
    const rows = this.db.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM source_documents d
        WHERE d.user_id = ?
        ORDER BY d.created_at DESC
        LIMIT ?`,
    ).all(userId, limit) as any[];
    return rows.map((r) => ({ ...this.rowToSourceDocument(r), chunkCount: (r.chunk_count as number) ?? 0 }));
  }

  /**
   * 0.4.3 — provenance-safe transcript retention. Every `/sources` row is an
   * auto-ingested per-turn transcript and there was no retention, so they grow
   * unbounded. This deletes `transcript` documents older than `beforeIso`
   * EXCEPT any whose chunks are still referenced by a cognitive_source_link
   * (i.e. a live memory was distilled from them) — so memory_verify /
   * provenance drill-down never breaks. Scoped by user_id (MEM-14).
   *
   * FK cascade is declared but NOT enforced in this store (no
   * `PRAGMA foreign_keys = ON`), so chunks are deleted explicitly. Returns the
   * counts removed. Non-transcript kinds are never touched.
   */
  public pruneTranscriptSources(userId: string, beforeIso: string): { prunedDocs: number; prunedChunks: number } {
    const doomed = this.db.prepare(
      `SELECT d.id FROM source_documents d
        WHERE d.user_id = ? AND d.kind = 'transcript' AND d.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM source_chunks c
            JOIN cognitive_source_links l ON l.chunk_id = c.id
            WHERE c.document_id = d.id
          )`,
    ).all(userId, beforeIso) as Array<{ id: string }>;
    if (doomed.length === 0) return { prunedDocs: 0, prunedChunks: 0 };

    const delChunks = this.db.prepare("DELETE FROM source_chunks WHERE document_id = ?");
    const delDoc = this.db.prepare("DELETE FROM source_documents WHERE id = ? AND user_id = ?");
    let prunedChunks = 0;
    for (const { id } of doomed) {
      prunedChunks += Number((delChunks.run(id) as { changes?: number }).changes ?? 0);
      delDoc.run(id, userId);
    }
    return { prunedDocs: doomed.length, prunedChunks };
  }

  /**
   * Insert a source document, or return the existing one with the same
   * (user_id, hash) — re-ingesting identical content is idempotent.
   */
  public createSourceDocument(
    input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): SourceDocument {
    const existing = this.getSourceDocumentByHash(input.userId, input.hash);
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
    this.db
      .prepare(
        `INSERT INTO source_documents (id, user_id, workspace_tag, kind, uri, hash, title, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.id, doc.userId, doc.workspaceTag, doc.kind, doc.uri, doc.hash, doc.title, doc.createdAt, JSON.stringify(doc.metadata ?? {}));
    return doc;
  }

  /** Append chunks to a document; ordinals continue from the current count. Chunk hash = sha1(content). */
  public addSourceChunks(documentId: string, chunks: SourceChunkInput[]): SourceChunk[] {
    const startOrdinal = ((this.db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE document_id = ?").get(documentId) as any)?.n ?? 0) as number;
    // MEM-14 — denormalize the parent doc's scope onto each chunk so chunk-level
    // queries stay scoped without a join.
    const parent = this.db.prepare("SELECT user_id, workspace_tag FROM source_documents WHERE id = ?").get(documentId) as { user_id?: string; workspace_tag?: string } | undefined;
    const stmt = this.db.prepare(
      `INSERT INTO source_chunks (id, document_id, user_id, workspace_tag, ordinal, content, token_count, file_path, symbol, start_line, end_line, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const out: SourceChunk[] = [];
    this.db.exec("BEGIN");
    try {
      chunks.forEach((c, i) => {
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
        stmt.run(chunk.id, chunk.documentId, parent?.user_id ?? null, parent?.workspace_tag ?? null, chunk.ordinal, chunk.content, chunk.tokenCount, chunk.filePath, chunk.symbol, chunk.startLine, chunk.endLine, chunk.hash);
        out.push(chunk);
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  public getSourceChunk(id: string): SourceChunk | null {
    const row = this.db.prepare("SELECT * FROM source_chunks WHERE id = ?").get(id) as any;
    return row ? this.rowToSourceChunk(row) : null;
  }

  public getSourceChunksByDocument(documentId: string): SourceChunk[] {
    const rows = this.db.prepare("SELECT * FROM source_chunks WHERE document_id = ? ORDER BY ordinal ASC").all(documentId) as any[];
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  /**
   * 0.4.3 — true if any chunk of this document is cited by a live memory's
   * provenance (cognitive_source_links). The source_chunker re-chunk job must
   * skip such docs: re-chunking changes chunk ids and would orphan the links.
   */
  public isSourceDocumentReferenced(documentId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM source_chunks c JOIN cognitive_source_links l ON l.chunk_id = c.id WHERE c.document_id = ? LIMIT 1",
    ).get(documentId);
    return !!row;
  }

  /**
   * 0.4.3 — replace a document's chunks (delete then re-add via addSourceChunks,
   * which restarts ordinals from 0 once the old rows are gone). Used by the
   * source_chunker re-chunk job; callers MUST guard provenance with
   * `isSourceDocumentReferenced` first (FK cascade is declared but not enforced
   * here, so the explicit delete is required).
   */
  public replaceSourceChunks(documentId: string, chunks: SourceChunkInput[]): SourceChunk[] {
    this.db.prepare("DELETE FROM source_chunks WHERE document_id = ?").run(documentId);
    return this.addSourceChunks(documentId, chunks);
  }

  /**
   * MEM-3 — link a cognitive record to the source chunks it was distilled
   * from (batch-level provenance). Idempotent (INSERT OR IGNORE on the
   * (record_id, chunk_id) primary key), so re-extraction doesn't duplicate.
   */
  public linkRecordSources(userId: string, recordId: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO cognitive_source_links (user_id, record_id, chunk_id, created_at) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const chunkId of chunkIds) stmt.run(userId, recordId, chunkId, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** MEM-3 — the source chunks a cognitive record cites, ordered by document + position. */
  public getRecordSourceChunks(userId: string, recordId: string): SourceChunk[] {
    const rows = this.db.prepare(
      `SELECT sc.* FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
        WHERE l.record_id = ? AND l.user_id = ?
        ORDER BY sc.document_id ASC, sc.ordinal ASC`,
    ).all(recordId, userId) as any[];
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  // ============================
  // Blackboard Items (MEM-4)
  // ============================

  private rowToBlackboardItem(row: any): BlackboardItem {
    return {
      id: row.id,
      userId: row.user_id,
      sourceChunkId: row.source_chunk_id ?? null,
      candidate: JSON.parse(row.candidate_json),
      score: row.score,
      status: row.status,
      conflictIds: row.conflict_ids_json ? JSON.parse(row.conflict_ids_json) : [],
      createdAt: row.created_at,
      committedRecordId: row.committed_record_id ?? null,
    };
  }

  /** MEM-4 — stage extracted candidates as `pending` blackboard items. */
  public stageBlackboardItems(userId: string, items: BlackboardItemInput[]): BlackboardItem[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO memory_blackboard_items (id, user_id, source_chunk_id, candidate_json, score, status, conflict_ids_json, created_at, committed_record_id)
       VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?, NULL)`,
    );
    const staged: BlackboardItem[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of items) {
        const id = `bb_${randomUUID()}`;
        stmt.run(id, userId, input.sourceChunkId ?? null, JSON.stringify(input.candidate), input.score ?? 0, now);
        staged.push({
          id, userId, sourceChunkId: input.sourceChunkId ?? null, candidate: input.candidate,
          score: input.score ?? 0, status: "pending", conflictIds: [], createdAt: now, committedRecordId: null,
        });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return staged;
  }

  public getBlackboardItem(id: string): BlackboardItem | null {
    const row = this.db.prepare("SELECT * FROM memory_blackboard_items WHERE id = ? LIMIT 1").get(id) as any;
    return row ? this.rowToBlackboardItem(row) : null;
  }

  public getBlackboardItems(userId: string, status?: BlackboardStatus): BlackboardItem[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM memory_blackboard_items WHERE user_id = ? AND status = ? ORDER BY score DESC, created_at ASC").all(userId, status)
      : this.db.prepare("SELECT * FROM memory_blackboard_items WHERE user_id = ? ORDER BY created_at ASC").all(userId)) as any[];
    return rows.map((r) => this.rowToBlackboardItem(r));
  }

  /** MEM-4 — patch a blackboard item's reconcile/commit state. */
  public updateBlackboardItem(
    id: string,
    patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null },
  ): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.score !== undefined) { sets.push("score = ?"); vals.push(patch.score); }
    if (patch.conflictIds !== undefined) { sets.push("conflict_ids_json = ?"); vals.push(JSON.stringify(patch.conflictIds)); }
    if (patch.committedRecordId !== undefined) { sets.push("committed_record_id = ?"); vals.push(patch.committedRecordId); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE memory_blackboard_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  // ============================
  // Memory Tree (MEM-5)
  // ============================

  private rowToTreeNode(row: any): MemoryTreeNode {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      parentId: row.parent_id ?? null,
      level: row.level,
      summaryMd: row.summary_md ?? "",
      sourceChunkIds: row.source_chunk_ids_json ? JSON.parse(row.source_chunk_ids_json) : [],
      sealedAt: row.sealed_at ?? null,
      heatScore: row.heat_score ?? 0,
      createdAt: row.created_at,
    };
  }

  /** MEM-5 — append a tree node (leaf or parent). */
  public appendTreeNode(userId: string, input: MemoryTreeNodeInput): MemoryTreeNode {
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
    this.db.prepare(
      `INSERT INTO memory_tree_nodes (id, user_id, kind, parent_id, level, summary_md, source_chunk_ids_json, sealed_at, heat_score, created_at, scene_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(node.id, userId, node.kind, node.parentId, node.level, node.summaryMd, JSON.stringify(node.sourceChunkIds), node.heatScore, node.createdAt, input.sceneKey ?? null);
    return node;
  }

  // ── 0.4.3 (MEM-10) — scene-tree autobuild support ────────────────────────

  /** Distinct cognitive scenes for a user (non-archived, named), with counts. */
  public getDistinctScenes(userId: string): Array<{ sceneName: string; recordCount: number }> {
    const rows = this.db.prepare(
      `SELECT scene_name AS sceneName, COUNT(*) AS recordCount
         FROM cognitive_records
        WHERE user_id = ? AND archived = 0 AND scene_name IS NOT NULL AND scene_name != ''
        GROUP BY scene_name
        ORDER BY recordCount DESC`,
    ).all(userId) as Array<{ sceneName: string; recordCount: number }>;
    return rows.map((r) => ({ sceneName: r.sceneName, recordCount: Number(r.recordCount) }));
  }

  /** Scene keys that already have a tree leaf (so the autobuilder doesn't re-leaf). */
  public getSceneLeafKeys(userId: string): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT scene_key FROM memory_tree_nodes WHERE user_id = ? AND scene_key IS NOT NULL",
    ).all(userId) as Array<{ scene_key: string }>;
    return rows.map((r) => r.scene_key);
  }

  /** Recent record contents for a scene — fodder for a deterministic leaf summary. */
  public getSceneRecordContents(userId: string, sceneName: string, limit = 8): string[] {
    const rows = this.db.prepare(
      `SELECT content FROM cognitive_records
        WHERE user_id = ? AND scene_name = ? AND archived = 0
        ORDER BY created_time DESC LIMIT ?`,
    ).all(userId, sceneName, limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  /** Unsealed, un-parented scene leaves (level 0) oldest-first — the seal bucket. */
  public getUnsealedSceneLeaves(userId: string, limit = 50): MemoryTreeNode[] {
    const rows = this.db.prepare(
      `SELECT * FROM memory_tree_nodes
        WHERE user_id = ? AND scene_key IS NOT NULL AND level = 0 AND sealed_at IS NULL AND parent_id IS NULL
        ORDER BY created_at ASC LIMIT ?`,
    ).all(userId, limit) as any[];
    return rows.map((r) => this.rowToTreeNode(r));
  }

  public getTreeNode(id: string): MemoryTreeNode | null {
    const row = this.db.prepare("SELECT * FROM memory_tree_nodes WHERE id = ? LIMIT 1").get(id) as any;
    return row ? this.rowToTreeNode(row) : null;
  }

  public getTreeChildren(parentId: string): MemoryTreeNode[] {
    const rows = this.db.prepare("SELECT * FROM memory_tree_nodes WHERE parent_id = ? ORDER BY created_at ASC").all(parentId) as any[];
    return rows.map((r) => this.rowToTreeNode(r));
  }

  /** Top-level nodes (no parent), optionally filtered by kind. */
  public getTreeRoots(userId: string, kind?: MemoryTreeKind): MemoryTreeNode[] {
    const rows = (kind
      ? this.db.prepare("SELECT * FROM memory_tree_nodes WHERE user_id = ? AND parent_id IS NULL AND kind = ? ORDER BY heat_score DESC, created_at ASC").all(userId, kind)
      : this.db.prepare("SELECT * FROM memory_tree_nodes WHERE user_id = ? AND parent_id IS NULL ORDER BY heat_score DESC, created_at ASC").all(userId)) as any[];
    return rows.map((r) => this.rowToTreeNode(r));
  }

  /** Re-parent a set of nodes under a freshly created parent (used when summarizing a bucket). */
  public setTreeParent(childIds: string[], parentId: string): void {
    if (childIds.length === 0) return;
    const stmt = this.db.prepare("UPDATE memory_tree_nodes SET parent_id = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const id of childIds) stmt.run(parentId, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** MEM-5 — seal a bucket: no more leaves append under it. */
  public sealTreeNode(id: string): void {
    this.db.prepare("UPDATE memory_tree_nodes SET sealed_at = ? WHERE id = ? AND sealed_at IS NULL").run(new Date().toISOString(), id);
  }

  /** MEM-7 — all tree nodes for a user (vault export reads the whole tree). */
  public getAllTreeNodes(userId: string): MemoryTreeNode[] {
    const rows = this.db.prepare("SELECT * FROM memory_tree_nodes WHERE user_id = ? ORDER BY level ASC, created_at ASC").all(userId) as any[];
    return rows.map((r) => this.rowToTreeNode(r));
  }

  // ============================
  // Vault Export Ledger (MEM-7)
  // ============================

  public upsertVaultExport(userId: string, input: VaultExportInput): void {
    this.db.prepare(
      `INSERT INTO vault_exports (user_id, path, hash, kind, ref_id, exported_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, path) DO UPDATE SET hash = excluded.hash, kind = excluded.kind, ref_id = excluded.ref_id, exported_at = excluded.exported_at`,
    ).run(userId, input.path, input.hash, input.kind, input.refId, new Date().toISOString());
  }

  public getVaultExports(userId: string): VaultExportEntry[] {
    const rows = this.db.prepare("SELECT * FROM vault_exports WHERE user_id = ? ORDER BY path ASC").all(userId) as any[];
    return rows.map((r) => ({ userId: r.user_id, path: r.path, hash: r.hash, kind: r.kind, refId: r.ref_id, exportedAt: r.exported_at }));
  }

  // ============================
  // Sensory Stream Methods
  // ============================

  public upsertSensory(record: SensoryRecord) {
    this.db.exec("BEGIN");
    try {
      this.stmtSensoryUpsertMeta.run(
        record.id, record.userId, record.sessionKey, record.sessionId, record.role,
        record.messageText, record.recordedAt, record.timestamp, record.skillTag
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public getRecentSensoryMessages(userId: string, sessionKey: string, limit: number, afterIsoTime = ""): SensoryRecord[] {
    const rows = this.stmtSensoryQueryAfter.all(userId, sessionKey, afterIsoTime, limit) as any[];
    // Reverse so chronologically they are oldest first
    return rows.reverse().map(r => ({
      id: r.id,
      userId: r.userId,
      sessionKey: r.sessionKey,
      sessionId: r.sessionId,
      role: r.role,
      messageText: r.messageText,
      recordedAt: r.recordedAt,
      timestamp: r.timestamp,
      skillTag: r.skillTag
    }));
  }

  public getUnextractedSensoryCount(userId: string, sessionKey: string): number {
    const stmtCount = this.db.prepare("SELECT COUNT(*) as count FROM sensory_stream WHERE user_id = ? AND session_key = ? AND extracted_at IS NULL");
    const row = stmtCount.get(userId, sessionKey) as any;
    return row?.count || 0;
  }

  public markSensoryExtracted(userId: string, sessionKey: string, recordIds: string[], extractedAt = new Date().toISOString()): void {
    if (recordIds.length === 0) return;

    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare("UPDATE sensory_stream SET extracted_at = ? WHERE user_id = ? AND session_key = ? AND record_id = ?");
      for (const recordId of recordIds) {
        stmt.run(extractedAt, userId, sessionKey, recordId);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ============================
  // Cognitive Methods
  // ============================

  public upsertCognitiveBatch(entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>, options?: { skipAudit?: boolean }) {
    this.db.exec("BEGIN");
    try {
      const deleteFts = this.db.prepare("DELETE FROM cognitive_fts WHERE record_id = ? AND user_id = ?");
      for (const entry of entries) {
        const record = entry.record;
        this.stmtCognitiveUpsertMeta.run(
          record.id, record.userId, record.sessionKey, record.sessionId, record.content,
          record.type, record.priority, record.sceneName, record.skillTag,
          record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
          record.timestampStart, record.timestampEnd, record.createdTime,
          record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
          record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
          JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
          JSON.stringify(record.commands ?? []), record.workspaceTag ?? null, record.projectTag ?? null
        );

        // FTS5 Insert
        deleteFts.run(record.id, record.userId);
        this.stmtCognitiveFtsInsert.run(
          record.content, record.content, record.id, record.userId, record.type,
          record.priority, record.sceneName, record.skillTag, record.sessionKey,
          record.timestampStr, record.createdTime
        );

        // Vector Insert
        if (entry.embedding && this.vecLoaded && this.stmtCognitiveVecInsert && this.stmtCognitiveVecDelete) {
          this.stmtCognitiveVecDelete.run(record.id);
          this.stmtCognitiveVecInsert.run(record.id, entry.embedding);
        }
        this.replaceFileIndex(record);

        if (!options?.skipAudit) {
          this.insertOperation({
            id: randomUUID(),
            userId: record.userId,
            recordId: record.id,
            operation: "cognitive_upsert",
            actor: "system",
            sessionKey: record.sessionKey,
            reason: "",
            createdAt: new Date().toISOString(),
            metadata: { batch: true, type: record.type },
          });
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public upsertCognitive(record: CognitiveRecord, options?: { skipAudit?: boolean }) {
    this.db.exec("BEGIN");
    try {
      this.stmtCognitiveUpsertMeta.run(
        record.id, record.userId, record.sessionKey, record.sessionId, record.content,
        record.type, record.priority, record.sceneName, record.skillTag,
        record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
        record.timestampStart, record.timestampEnd, record.createdTime,
        record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
        record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
        JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
        JSON.stringify(record.commands ?? []), record.workspaceTag ?? null, record.projectTag ?? null
      );

      // FTS5 Insert (delete old first if it exists to emulate UPSERT)
      const deleteFts = this.db.prepare("DELETE FROM cognitive_fts WHERE record_id = ? AND user_id = ?");
      deleteFts.run(record.id, record.userId);
      
      this.stmtCognitiveFtsInsert.run(
        record.content, record.content, record.id, record.userId, record.type,
        record.priority, record.sceneName, record.skillTag, record.sessionKey,
        record.timestampStr, record.createdTime
      );
      this.replaceFileIndex(record);

      if (!options?.skipAudit) {
        this.insertOperation({
          id: randomUUID(),
          userId: record.userId,
          recordId: record.id,
          operation: "cognitive_upsert",
          actor: "system",
          sessionKey: record.sessionKey,
          reason: "",
          createdAt: new Date().toISOString(),
          metadata: { type: record.type },
        });
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public invalidateCognitiveRecord(userId: string, recordId: string, supersededById: string) {
    const stmt = this.db.prepare(
      "UPDATE cognitive_records SET invalid_at = ?, superseded_by = ?, status = 'superseded' WHERE user_id = ? AND record_id = ?"
    );
    const now = new Date().toISOString();
    stmt.run(now, supersededById, userId, recordId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "cognitive_supersede",
      actor: "system",
      sessionKey: "",
      reason: `Superseded by ${supersededById}`,
      createdAt: now,
      metadata: { supersededById },
    });
  }

  public getMemoryById(userId: string, recordId: string): CognitiveRecord | null {
    const row = this.stmtCognitiveGetMeta.get(recordId, userId) as any;
    return row ? cognitiveRowToRecord(row) : null;
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit: number): CognitiveRecord[] {
    const rows = this.db.prepare(`
      SELECT r.*
      FROM memory_file_index i
      JOIN cognitive_records r ON r.user_id = i.user_id AND r.record_id = i.record_id
      WHERE i.user_id = ?
        AND (i.file_path = ? OR i.file_path LIKE ?)
        AND r.invalid_at IS NULL
        AND r.archived = 0
      ORDER BY i.created_time DESC, r.priority DESC
      LIMIT ?
    `).all(userId, filePath, `%${filePath}%`, limit) as any[];
    return rows.map(cognitiveRowToRecord);
  }

  public updateCognitiveConfidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cognitive_records SET confidence = ?, status = ?, archived = CASE WHEN ? = 'archived' THEN 1 ELSE archived END, updated_time = ? WHERE user_id = ? AND record_id = ?"
    ).run(confidence, status, status, now, userId, recordId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "cognitive_status_update",
      actor: "system",
      sessionKey: "",
      reason: "",
      createdAt: now,
      metadata: { confidence, status },
    });
  }

  public insertEvidence(ev: MemoryEvidence): void {
    this.db.prepare(`
      INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,
        ref=excluded.ref,
        excerpt=excluded.excerpt,
        observed_at=excluded.observed_at,
        metadata_json=excluded.metadata_json
    `).run(ev.id, ev.userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {}));
    this.insertOperation({
      id: randomUUID(),
      userId: ev.userId,
      recordId: ev.recordId,
      operation: "evidence_add",
      actor: "system",
      sessionKey: "",
      reason: "",
      createdAt: new Date().toISOString(),
      metadata: { evidenceId: ev.id, kind: ev.kind, ref: ev.ref },
    });
  }

  public getEvidenceByRecord(userId: string, recordId: string): MemoryEvidence[] {
    const rows = this.db.prepare(`
      SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
      FROM memory_evidence
      WHERE user_id = ? AND record_id = ?
      ORDER BY observed_at DESC, id ASC
    `).all(userId, recordId) as any[];
    return rows.map(evidenceRowToRecord);
  }

  public listEvidence(
    userId: string,
    filters?: EvidenceListFilters,
    pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>
  ): MemoryEvidence[] {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.recordId) {
      where.push("record_id = ?");
      args.push(filters.recordId);
    }
    if (filters?.kind) {
      where.push("kind = ?");
      args.push(filters.kind);
    }
    if (pagination?.cursor) {
      where.push("(observed_at < ? OR (observed_at = ? AND id > ?))");
      args.push(pagination.cursor.observedAt, pagination.cursor.observedAt, pagination.cursor.id);
    }
    args.push(pagination?.limit ?? 100);
    const rows = this.db.prepare(`
      SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
      FROM memory_evidence
      WHERE ${where.join(" AND ")}
      ORDER BY observed_at DESC, id ASC
      LIMIT ?
    `).all(...args) as any[];
    return rows.map(evidenceRowToRecord);
  }

  public insertOperation(op: MemoryOperation): void {
    this.db.prepare(`
      INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        operation=excluded.operation,
        actor=excluded.actor,
        session_key=excluded.session_key,
        reason=excluded.reason,
        metadata_json=excluded.metadata_json
    `).run(
      op.id,
      op.userId,
      op.recordId,
      op.operation,
      op.actor,
      op.sessionKey,
      op.reason,
      op.createdAt,
      JSON.stringify(op.metadata ?? {})
    );
  }

  public getOperationLog(
    userId: string,
    options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
    filters?: OperationLogFilters
  ): MemoryOperation[] {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.operation) {
      where.push("operation = ?");
      args.push(filters.operation);
    }
    if (filters?.sessionKey) {
      where.push("session_key = ?");
      args.push(filters.sessionKey);
    }
    if (filters?.createdAfter) {
      where.push("created_at >= ?");
      args.push(filters.createdAfter);
    }
    if (filters?.createdBefore) {
      where.push("created_at <= ?");
      args.push(filters.createdBefore);
    }
    if (options?.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id > ?))");
      args.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    }
    args.push(options?.limit ?? 100);
    const rows = this.db.prepare(`
      SELECT id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json
      FROM memory_operations
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `).all(...args) as any[];
    return rows.map(operationRowToRecord);
  }

  public exportMemories(userId: string): MemoryExport {
    const memoryRows = this.db.prepare("SELECT * FROM cognitive_records WHERE user_id = ? ORDER BY created_time ASC, record_id ASC").all(userId) as any[];
    const evidenceRows = this.db.prepare("SELECT * FROM memory_evidence WHERE user_id = ? ORDER BY observed_at ASC, id ASC").all(userId) as any[];
    const operationRows = this.db.prepare("SELECT * FROM memory_operations WHERE user_id = ? ORDER BY created_at ASC, id ASC").all(userId) as any[];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      userId,
      memories: memoryRows.map(cognitiveRowToRecord),
      evidence: evidenceRows.map(evidenceRowToRecord),
      operations: operationRows.map(operationRowToRecord),
    };
  }

  public importMemories(userId: string, data: MemoryImport): ImportResult {
    let importedMemories = 0;
    let importedEvidence = 0;
    let importedOperations = 0;

    this.db.exec("BEGIN");
    try {
      for (const record of data.memories ?? []) {
        this.stmtCognitiveUpsertMeta.run(
          record.id, userId, record.sessionKey, record.sessionId, record.content,
          record.type, record.priority, record.sceneName, record.skillTag,
          record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
          record.timestampStart, record.timestampEnd, record.createdTime,
          record.updatedTime, JSON.stringify(record.metadata ?? {}), record.confidence ?? 0.65,
          record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
          JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
          JSON.stringify(record.commands ?? []), record.workspaceTag ?? null, record.projectTag ?? null
        );
        this.db.prepare("DELETE FROM cognitive_fts WHERE record_id = ? AND user_id = ?").run(record.id, userId);
        this.stmtCognitiveFtsInsert.run(
          record.content, record.content, record.id, userId, record.type,
          record.priority, record.sceneName, record.skillTag, record.sessionKey,
          record.timestampStr, record.createdTime
        );
        this.replaceFileIndex({ ...record, userId });
        importedMemories++;
      }
      for (const ev of data.evidence ?? []) {
        this.db.prepare(`
          INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind=excluded.kind,
            ref=excluded.ref,
            excerpt=excluded.excerpt,
            observed_at=excluded.observed_at,
            metadata_json=excluded.metadata_json
        `).run(ev.id, userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {}));
        importedEvidence++;
      }
      for (const op of data.operations ?? []) {
        this.db.prepare(`
          INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).run(op.id, userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {}));
        importedOperations++;
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
        VALUES (?, ?, NULL, 'import', 'system', '', '', ?, ?)
      `).run(randomUUID(), userId, now, JSON.stringify({ importedMemories, importedEvidence, importedOperations }));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { importedMemories, importedEvidence, importedOperations };
  }

  public hardDeleteMemory(userId: string, recordId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM memory_evidence WHERE user_id = ? AND record_id = ?").run(userId, recordId);
      this.db.prepare("DELETE FROM memory_file_index WHERE user_id = ? AND record_id = ?").run(userId, recordId);
      this.db.prepare("DELETE FROM cognitive_fts WHERE user_id = ? AND record_id = ?").run(userId, recordId);
      if (this.stmtCognitiveVecDelete) {
        this.stmtCognitiveVecDelete.run(recordId);
      }
      this.db.prepare("DELETE FROM cognitive_records WHERE user_id = ? AND record_id = ?").run(userId, recordId);
      this.db.prepare(`
        INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
        VALUES (?, ?, ?, 'governance_delete', 'system', '', ?, ?, '{}')
      `).run(randomUUID(), userId, recordId, reason, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public searchCognitiveFts(userId: string, query: string, limit: number): CognitiveFtsResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.stmtCognitiveFtsSearch.all(userId, ftsQuery, limit) as any[];
    return rows.map(r => ({
      record_id: r.record_id,
      user_id: r.user_id,
      content: r.content,
      type: r.type,
      priority: r.priority,
      scene_name: r.scene_name,
      skill_tag: r.skill_tag,
      score: bm25RankToScore(r.rank),
      timestamp_str: r.timestamp_str,
      timestamp_start: "",
      timestamp_end: "",
      session_key: r.session_key,
      session_id: "",
      metadata_json: "{}",
      created_time: r.created_time,
      citation_count: r.citation_count ?? 0
    }));
  }

  public searchCognitiveFtsAsOf(userId: string, query: string, limit: number, asOf: string): CognitiveFtsResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const stmt = this.db.prepare(`
      SELECT 
        f.record_id, f.user_id, f.content_original as content, f.type, f.priority, f.scene_name,
        f.skill_tag, f.session_key, f.timestamp_str, f.created_time,
        f.rank
      FROM cognitive_fts f
      JOIN cognitive_records r ON f.record_id = r.record_id
      WHERE f.user_id = ?
        AND cognitive_fts MATCH ?
        AND r.created_time <= ?          -- memory must have existed at asOf
        AND (r.invalid_at IS NULL OR r.invalid_at > ?)  -- must have been valid at asOf
        AND r.archived = 0
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(userId, ftsQuery, asOf, asOf, limit) as any[];
    return rows.map(r => ({
      record_id: r.record_id,
      user_id: r.user_id,
      content: r.content,
      type: r.type,
      priority: r.priority,
      scene_name: r.scene_name,
      skill_tag: r.skill_tag,
      score: bm25RankToScore(r.rank),
      timestamp_str: r.timestamp_str,
      timestamp_start: "",
      timestamp_end: "",
      session_key: r.session_key,
      session_id: "",
      metadata_json: "{}",
      created_time: r.created_time
    }));
  }

  public upsertCognitiveVec(recordId: string, embedding: Float32Array) {
    if (!this.vecLoaded) return;
    
    if (this.vecDimensions !== embedding.length) {
      this.initVec(embedding.length);
    }

    if (!this.stmtCognitiveVecInsert || !this.stmtCognitiveVecDelete) return;
    
    this.db.exec("BEGIN");
    try {
      this.stmtCognitiveVecDelete.run(recordId);
      this.stmtCognitiveVecInsert.run(recordId, embedding);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number): VectorSearchResult[] {
    if (!this.vecLoaded) return [];

    if (this.vecDimensions !== queryEmbedding.length) {
      this.initVec(queryEmbedding.length);
    }

    if (!this.vecDimensions) return [];

    const stmt = this.db.prepare(`
      SELECT 
        v.record_id, v.distance,
        r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
        r.session_key, r.timestamp_str, r.created_time
      FROM cognitive_vec v
      JOIN cognitive_records r ON v.record_id = r.record_id
      WHERE v.embedding MATCH ? AND k = ? AND r.user_id = ? AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY distance
    `);

    try {
      const rows = stmt.all(queryEmbedding, limit, userId) as any[];
      return rows.map(r => ({
        record_id: r.record_id,
        user_id: r.user_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        skill_tag: r.skill_tag,
        score: 1 - r.distance,
        timestamp_str: r.timestamp_str,
        timestamp_start: "",
        timestamp_end: "",
        session_key: r.session_key,
        session_id: "",
        metadata_json: "{}",
        created_time: r.created_time
      }));
    } catch (e) {
      console.error("[BrainRouter] Vector search failed:", e);
      return [];
    }
  }

  public upsertContradiction(data: {
    id: string;
    userId: string;
    recordIdA: string;
    recordIdB: string;
    reason: string;
    confidence: number;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO contradictions (id, user_id, record_id_a, record_id_b, reason, confidence, created_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reason=excluded.reason,
        confidence=excluded.confidence
    `);
    stmt.run(data.id, data.userId, data.recordIdA, data.recordIdB, data.reason, data.confidence, new Date().toISOString());
  }

  public getPendingContradictions(userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>): ContradictionRecord[] {
    const where = ["c.user_id = ?", "c.status = 'pending'"];
    const args: any[] = [userId];
    if (pagination?.cursor) {
      where.push("(c.confidence < ? OR (c.confidence = ? AND c.id > ?))");
      args.push(pagination.cursor.confidence, pagination.cursor.confidence, pagination.cursor.id);
    }
    args.push(pagination?.limit ?? 20);
    const stmt = this.db.prepare(`
      SELECT c.*, r1.content as content_a, r2.content as content_b
      FROM contradictions c
      JOIN cognitive_records r1 ON c.record_id_a = r1.record_id
      JOIN cognitive_records r2 ON c.record_id_b = r2.record_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.confidence DESC, c.id ASC
      LIMIT ?
    `);
    return stmt.all(...args) as unknown as ContradictionRecord[];
  }

  public resolveContradiction(id: string, userId: string, status: 'resolved' | 'dismissed') {
    const stmt = this.db.prepare("UPDATE contradictions SET status = ? WHERE id = ? AND user_id = ?");
    stmt.run(status, id, userId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId: id,
      operation: "contradiction_resolve",
      actor: "system",
      sessionKey: "",
      reason: status,
      createdAt: new Date().toISOString(),
      metadata: { contradictionId: id, status },
    });
  }

  // ============================
  // Skill Hints Methods
  // ============================

  public upsertSkillHints(skillName: string, hints: string, sourceFile = "") {
    const stmt = this.db.prepare(`
      INSERT INTO skill_extraction_hints (skill_name, hints, source_file, registered_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        hints=excluded.hints,
        source_file=excluded.source_file,
        registered_at=excluded.registered_at
    `);
    stmt.run(skillName, hints, sourceFile, new Date().toISOString());
  }

  public listSkillHints(): SkillHintsRecord[] {
    const stmt = this.db.prepare("SELECT skill_name, hints, source_file, registered_at FROM skill_extraction_hints ORDER BY registered_at DESC");
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      skillName: r.skill_name,
      hints: r.hints,
      sourceFile: r.source_file,
      registeredAt: r.registered_at
    }));
  }

  // ============================
  // Contextual Focus Methods
  // ============================

  public upsertContextualFocus(record: ContextualFocusRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO contextual_focus (id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, scene_name) DO UPDATE SET
        summary_md=excluded.summary_md,
        heat_score=excluded.heat_score,
        last_active_time=excluded.last_active_time,
        updated_time=excluded.updated_time
    `);
    stmt.run(
      record.id, record.userId, record.sceneName, record.summaryMd,
      record.heatScore, record.lastActiveTime, record.createdTime, record.updatedTime
    );
  }

  public getTopContextualFocus(userId: string, limit = 3, cursor?: { heatScore: number; id: string }): ContextualFocusRecord[] {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (cursor) {
      where.push("(heat_score < ? OR (heat_score = ? AND id > ?))");
      args.push(cursor.heatScore, cursor.heatScore, cursor.id);
    }
    args.push(limit);
    const stmt = this.db.prepare(
      `SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time
       FROM contextual_focus
       WHERE ${where.join(" AND ")}
       ORDER BY heat_score DESC, id ASC
       LIMIT ?`
    );
    const rows = stmt.all(...args) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, sceneName: r.scene_name,
      summaryMd: r.summary_md, heatScore: r.heat_score,
      lastActiveTime: r.last_active_time, createdTime: r.created_time, updatedTime: r.updated_time
    }));
  }

  public decayContextualFocusHeatScores(userId: string, decayFactor = 0.95) {
    const stmt = this.db.prepare("UPDATE contextual_focus SET heat_score = heat_score * ? WHERE user_id = ?");
    stmt.run(decayFactor, userId);
  }

  public boostContextualFocusHeatScore(userId: string, sceneName: string, boost = 20) {
    const stmt = this.db.prepare("UPDATE contextual_focus SET heat_score = MIN(100.0, heat_score + ?), last_active_time = ? WHERE user_id = ? AND scene_name = ?");
    stmt.run(boost, new Date().toISOString(), userId, sceneName);
  }

  public getCognitivesByFocus(userId: string, sceneName: string, limit = 30): any[] {
    const stmt = this.db.prepare(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = ? AND scene_name = ? AND invalid_at IS NULL ORDER BY priority DESC LIMIT ?"
    );
    return stmt.all(userId, sceneName, limit) as any[];
  }

  public getContextualFocusCount(userId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM contextual_focus WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    return row?.count || 0;
  }

  public getColdContextualFocus(userId: string, limit: number): ContextualFocusRecord[] {
    const stmt = this.db.prepare(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = ? ORDER BY heat_score ASC LIMIT ?"
    );
    const rows = stmt.all(userId, limit) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, sceneName: r.scene_name,
      summaryMd: r.summary_md, heatScore: r.heat_score,
      lastActiveTime: r.last_active_time, createdTime: r.created_time, updatedTime: r.updated_time
    }));
  }

  public deleteContextualFocus(userId: string, sceneIds: string[]) {
    if (sceneIds.length === 0) return;
    const placeholders = sceneIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`DELETE FROM contextual_focus WHERE user_id = ? AND id IN (${placeholders})`);
    stmt.run(userId, ...sceneIds);
  }

  public getContextualFocusByName(userId: string, sceneName: string): ContextualFocusRecord | null {
    const stmt = this.db.prepare(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM contextual_focus WHERE user_id = ? AND scene_name = ?"
    );
    const row = stmt.get(userId, sceneName) as any;
    if (!row) return null;
    return {
      id: row.id, userId: row.user_id, sceneName: row.scene_name,
      summaryMd: row.summary_md, heatScore: row.heat_score,
      lastActiveTime: row.last_active_time, createdTime: row.created_time, updatedTime: row.updated_time
    };
  }

  public getDistinctSceneNames(userId: string): string[] {
    const stmt = this.db.prepare("SELECT DISTINCT scene_name FROM cognitive_records WHERE user_id = ? AND scene_name != ''");
    const rows = stmt.all(userId) as any[];
    return rows.map(r => r.scene_name);
  }

  public renameFocusInCognitiveRecords(userId: string, oldName: string, canonicalName: string) {
    this.db.exec("BEGIN");
    try {
      const stmtUpdate = this.db.prepare(
        "UPDATE cognitive_records SET scene_name = ?, updated_time = ? WHERE user_id = ? AND scene_name = ?"
      );
      stmtUpdate.run(canonicalName, new Date().toISOString(), userId, oldName);

      const stmtDelete = this.db.prepare(
        "DELETE FROM contextual_focus WHERE user_id = ? AND scene_name = ?"
      );
      stmtDelete.run(userId, oldName);

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ============================
  // Core Identity Methods
  // ============================

  /**
   * Federation Stage 1 (0.4.0) — batch lookup of `workspace_tag` for
   * recall filtering. Returns a Map keyed by recordId; ids not present
   * in the DB and ids with NULL tag both map to `null`. The caller
   * (recall pipeline) is responsible for applying NULL-tolerant logic.
   */
  public getWorkspaceTagsByRecordIds(userId: string, recordIds: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    if (recordIds.length === 0) return result;
    // Pre-fill every id with null so missing rows fall through to the
    // NULL-tolerant filter branch instead of being dropped silently.
    for (const id of recordIds) result.set(id, null);
    const placeholders = recordIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT record_id, workspace_tag FROM cognitive_records WHERE user_id = ? AND record_id IN (${placeholders})`,
      )
      .all(userId, ...recordIds) as Array<{ record_id: string; workspace_tag: string | null }>;
    for (const row of rows) {
      result.set(row.record_id, row.workspace_tag ?? null);
    }
    return result;
  }

  // AUG-A1 (0.4.1) — project-tag twin of getWorkspaceTagsByRecordIds.
  public getProjectTagsByRecordIds(userId: string, recordIds: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    if (recordIds.length === 0) return result;
    for (const id of recordIds) result.set(id, null);
    const placeholders = recordIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT record_id, project_tag FROM cognitive_records WHERE user_id = ? AND record_id IN (${placeholders})`,
      )
      .all(userId, ...recordIds) as Array<{ record_id: string; project_tag: string | null }>;
    for (const row of rows) {
      result.set(row.record_id, row.project_tag ?? null);
    }
    return result;
  }

  // ── Federation Stage 2 (0.4.0): active session registry ────────────────

  public registerActiveSession(record: ActiveSessionRecord): ActiveSessionRecord {
    // Idempotent upsert. On insert, `started_at` is set from the record.
    // On conflict we preserve the existing `started_at` (so a re-register
    // does not reset the session's lifetime) but always advance
    // `last_heartbeat_at` and refresh client metadata / usage.
    this.db
      .prepare(
        `INSERT INTO active_sessions (session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key, user_id) DO UPDATE SET
           client_kind = excluded.client_kind,
           workspace_root = excluded.workspace_root,
           last_heartbeat_at = excluded.last_heartbeat_at,
           metadata_json = excluded.metadata_json,
           usage_json = COALESCE(excluded.usage_json, active_sessions.usage_json)`,
      )
      .run(
        record.sessionKey,
        record.userId,
        record.clientKind,
        record.workspaceRoot,
        record.startedAt,
        record.lastHeartbeatAt,
        JSON.stringify(record.metadata ?? {}),
        record.usage ? JSON.stringify(record.usage) : null,
      );
    return this.getActiveSession(record.userId, record.sessionKey)!;
  }

  public heartbeatActiveSession(
    userId: string,
    sessionKey: string,
    at: string,
    usage?: ActiveSessionUsage | null,
  ): boolean {
    // Heartbeats are 1-per-30s × N peers; deliberately omit the
    // operation_log write that other mutators emit (audit volume
    // guard per FED-S2-T3).
    const result = this.db
      .prepare(
        `UPDATE active_sessions
         SET last_heartbeat_at = ?,
             usage_json = COALESCE(?, usage_json)
         WHERE session_key = ? AND user_id = ?`,
      )
      .run(at, usage ? JSON.stringify(usage) : null, sessionKey, userId);
    return Number(result.changes ?? 0) > 0;
  }

  public listActiveSessions(filters: ActiveSessionFilters): ActiveSessionRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.userId) {
      where.push("user_id = ?");
      params.push(filters.userId);
    }
    if (filters.clientKind) {
      where.push("client_kind = ?");
      params.push(filters.clientKind);
    }
    if (filters.workspaceRoot) {
      where.push("workspace_root = ?");
      params.push(filters.workspaceRoot);
    }
    if (!filters.includeStale) {
      const threshold = filters.staleThresholdMs ?? 2 * 60 * 1000;
      const cutoff = new Date(Date.now() - threshold).toISOString();
      where.push("last_heartbeat_at >= ?");
      params.push(cutoff);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
         FROM active_sessions
         ${whereSql}
         ORDER BY last_heartbeat_at DESC, session_key ASC`,
      )
      .all(...params) as Array<{
        session_key: string;
        user_id: string;
        client_kind: string;
        workspace_root: string;
        started_at: string;
        last_heartbeat_at: string;
        metadata_json: string | null;
        usage_json: string | null;
      }>;
    return rows.map((row) => activeSessionRowToRecord(row, filters.includeUsage ?? false));
  }

  public unregisterActiveSession(userId: string, sessionKey: string): boolean {
    // Mirror `heartbeatActiveSession` — skip the `operation_log` write.
    // Federation churn is high-volume and audit value is low: we already
    // have `started_at` / `last_heartbeat_at` on the row itself, and a
    // dropped row is just absence-of-row.
    const result = this.db
      .prepare("DELETE FROM active_sessions WHERE session_key = ? AND user_id = ?")
      .run(sessionKey, userId);
    return Number(result.changes ?? 0) > 0;
  }

  // ── Federation Stage 3 (0.4.0): cross-CLI inbox ────────────────────────

  public sendSessionMessage(
    record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">,
    options?: { idGenerator?: () => string; now?: string },
  ): SessionInboxRecord[] {
    const now = options?.now ?? new Date().toISOString();
    const idFor = options?.idGenerator ?? (() => randomUUID());

    // Resolve the addressing string into a concrete list of recipient
    // sessionKeys. Three shapes:
    //   1. `*`                   → every active peer under user_id
    //   2. `<clientKind>:*`      → every active peer matching that kind
    //   3. exact `<sessionKey>`  → singleton (no resolution needed)
    //
    // Broadcast forms only fan out to ACTIVE sessions (heartbeat within
    // the active window). A peer that's currently stale won't receive
    // the broadcast — by design; addressing into the past has no useful
    // semantics here.
    const recipients = this.resolveInboxRecipients(record.userId, record.toSessionKey);
    if (recipients.length === 0) return [];

    const stmt = this.db.prepare(
      `INSERT INTO session_inbox (id, user_id, from_session_key, to_session_key, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const rows: SessionInboxRecord[] = [];
    for (const recipientSessionKey of recipients) {
      const id = idFor();
      stmt.run(
        id,
        record.userId,
        record.fromSessionKey,
        recipientSessionKey,
        record.kind,
        JSON.stringify(record.payload ?? {}),
        now,
      );
      rows.push({
        id,
        userId: record.userId,
        fromSessionKey: record.fromSessionKey,
        toSessionKey: recipientSessionKey,
        kind: record.kind,
        payload: record.payload ?? {},
        createdAt: now,
        deliveredAt: null,
      });
    }
    return rows;
  }

  private resolveInboxRecipients(userId: string, address: string): string[] {
    if (!address) return [];
    if (address === "*" || address.toLowerCase() === "broadcast") {
      return this.activeSessionKeysForUser(userId);
    }
    const wildcardMatch = /^([^:]+):\*$/.exec(address);
    if (wildcardMatch) {
      const clientKind = wildcardMatch[1];
      return this.activeSessionKeysForUser(userId, clientKind);
    }
    // Exact sessionKey — no need to verify it exists. The recipient
    // may have just disconnected; the row stays until read or swept.
    return [address];
  }

  private activeSessionKeysForUser(userId: string, clientKindFilter?: string): string[] {
    const activeCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const rows = clientKindFilter
      ? (this.db
          .prepare(
            `SELECT session_key FROM active_sessions
             WHERE user_id = ? AND client_kind = ? AND last_heartbeat_at >= ?`,
          )
          .all(userId, clientKindFilter, activeCutoff) as Array<{ session_key: string }>)
      : (this.db
          .prepare(
            `SELECT session_key FROM active_sessions
             WHERE user_id = ? AND last_heartbeat_at >= ?`,
          )
          .all(userId, activeCutoff) as Array<{ session_key: string }>);
    return rows.map((r) => r.session_key);
  }

  public readSessionInbox(filters: SessionInboxFilters): SessionInboxRecord[] {
    const limit = filters.limit ?? 50;
    const includeDelivered = filters.includeDelivered ?? false;
    const where: string[] = ["user_id = ?", "to_session_key = ?"];
    const params: (string | number)[] = [filters.userId, filters.toSessionKey];
    if (!includeDelivered) where.push("delivered_at IS NULL");
    const rows = this.db
      .prepare(
        `SELECT id, user_id, from_session_key, to_session_key, kind, payload_json, created_at, delivered_at
         FROM session_inbox
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
        id: string;
        user_id: string;
        from_session_key: string;
        to_session_key: string;
        kind: string;
        payload_json: string;
        created_at: string;
        delivered_at: string | null;
      }>;
    return rows.map(inboxRowToRecord);
  }

  public ackSessionInbox(
    userId: string,
    toSessionKey: string,
    ids: string[],
    at: string,
  ): number {
    if (ids.length === 0) return 0;
    // Use a single statement with an IN() clause built from placeholders.
    // Cap at 500 to avoid hitting SQLite's variable limit; callers
    // batch into smaller chunks if they need more.
    const capped = ids.slice(0, 500);
    const placeholders = capped.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE session_inbox
         SET delivered_at = ?
         WHERE user_id = ? AND to_session_key = ? AND delivered_at IS NULL
           AND id IN (${placeholders})`,
      )
      .run(at, userId, toSessionKey, ...capped);
    return Number(result.changes ?? 0);
  }

  public sweepSessionInbox(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare("DELETE FROM session_inbox WHERE delivered_at IS NOT NULL AND delivered_at < ?")
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  // ── FED-S5 (0.4.2): pending_delegations fallback queue ─────────────────

  private rowToPendingDelegation(row: any): PendingDelegationRecord {
    return {
      id: row.id,
      userId: row.user_id,
      fromSessionKey: row.from_session_key,
      toAgentKind: row.to_agent_kind,
      toSessionKey: row.to_session_key ?? null,
      packet: JSON.parse(row.packet_json || "{}") as DelegationPacket,
      status: row.status as PendingDelegationStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at ?? null,
    };
  }

  public enqueuePendingDelegation(
    input: PendingDelegationEnqueueInput,
    options?: { idGenerator?: () => string; now?: string },
  ): PendingDelegationRecord {
    const now = options?.now ?? new Date().toISOString();
    const id = (options?.idGenerator ?? (() => randomUUID()))();
    this.db
      .prepare(
        `INSERT INTO pending_delegations
           (id, user_id, from_session_key, to_agent_kind, to_session_key, packet_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.fromSessionKey,
        input.toAgentKind,
        JSON.stringify(input.packet ?? {}),
        now,
        now,
      );
    return {
      id,
      userId: input.userId,
      fromSessionKey: input.fromSessionKey,
      toAgentKind: input.toAgentKind,
      toSessionKey: null,
      packet: input.packet,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      claimedAt: null,
    };
  }

  public listPendingDelegations(filters: PendingDelegationFilters): PendingDelegationRecord[] {
    const clauses = ["user_id = ?"];
    const params: string[] = [filters.userId];
    if (filters.toAgentKind) {
      clauses.push("to_agent_kind = ?");
      params.push(filters.toAgentKind);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_delegations WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map((r) => this.rowToPendingDelegation(r));
  }

  public claimPendingDelegation(
    userId: string,
    toAgentKind: string,
    toSessionKey: string,
    at: string,
  ): PendingDelegationRecord | null {
    // Pick the oldest pending row of this kind, then flip it to claimed.
    // SQLite is single-writer so the SELECT→UPDATE is effectively atomic
    // within one store; distinct concurrent claimers get distinct rows.
    const row = this.db
      .prepare(
        `SELECT * FROM pending_delegations
           WHERE user_id = ? AND to_agent_kind = ? AND status = 'pending'
           ORDER BY created_at ASC LIMIT 1`,
      )
      .get(userId, toAgentKind) as any;
    if (!row) return null;
    this.db
      .prepare(
        `UPDATE pending_delegations
           SET status = 'claimed', to_session_key = ?, claimed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
      )
      .run(toSessionKey, at, at, row.id);
    return this.rowToPendingDelegation({
      ...row,
      status: "claimed",
      to_session_key: toSessionKey,
      claimed_at: at,
      updated_at: at,
    });
  }

  // ── BRAIN-P1 (0.4.1): memory_jobs queue (BRAIN-DESIGN-T2) ──────────────

  public enqueueMemoryJob(
    input: MemoryJobEnqueueInput,
    options?: { idGenerator?: () => string; now?: string },
  ): MemoryJobRecord {
    const now = options?.now ?? new Date().toISOString();
    const id = (options?.idGenerator ?? (() => randomUUID()))();
    const runAfter = input.runAfter ?? now;
    const priority = input.priority ?? 50;
    const maxAttempts = input.maxAttempts ?? 3;
    this.db
      .prepare(
        `INSERT INTO memory_jobs
           (id, kind, status, priority, attempts, max_attempts, run_after, locked_at,
            parent_job_id, input_json, output_json, error, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        priority,
        maxAttempts,
        runAfter,
        input.parentJobId ?? null,
        JSON.stringify(input.input ?? {}),
        now,
        now,
      );
    return this.getMemoryJob(id)!;
  }

  public getMemoryJob(id: string): MemoryJobRecord | null {
    const row = this.db
      .prepare(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = ?`)
      .get(id) as any;
    return row ? jobRowToRecord(row) : null;
  }

  public listMemoryJobs(filters?: MemoryJobListFilters): MemoryJobRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters?.kind) {
      where.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    const limit = filters?.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM memory_jobs
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY priority DESC, created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map(jobRowToRecord);
  }

  public claimNextMemoryJob(options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    // BEGIN IMMEDIATE takes the write lock up front so two federated
    // brain processes can't both claim the same row. The select-then-
    // update is one transaction; under WAL a second claimant blocks on
    // the write lock (busy_timeout) rather than racing.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(
          `SELECT id FROM memory_jobs
           WHERE status = 'pending' AND run_after <= ?
           ORDER BY priority DESC, run_after ASC, id ASC
           LIMIT 1`,
        )
        .get(now) as { id: string } | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'running', locked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, candidate.id);
      this.db.exec("COMMIT");
      return this.getMemoryJob(candidate.id);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  public startMemoryJob(id: string, options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'running', locked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, now, id);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryJob(id);
  }

  public completeMemoryJob(
    id: string,
    output: unknown,
    options?: { now?: string },
  ): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'done', output_json = ?, error = NULL, locked_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(output ?? null), now, id);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryJob(id);
  }

  public failMemoryJob(
    id: string,
    error: string,
    options?: { now?: string; backoffMs?: number },
  ): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const job = this.getMemoryJob(id);
    if (!job || job.status !== "running") return null;
    const attempts = job.attempts + 1;
    if (attempts < job.maxAttempts) {
      const runAfter = new Date(Date.parse(now) + (options?.backoffMs ?? 0)).toISOString();
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'pending', attempts = ?, error = ?, run_after = ?, locked_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(attempts, error, runAfter, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'failed', attempts = ?, error = ?, locked_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(attempts, error, now, id);
    }
    return this.getMemoryJob(id);
  }

  public retryMemoryJob(id: string, options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'pending', attempts = 0, run_after = ?, locked_at = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      )
      .run(now, now, id);
    if (Number(result.changes ?? 0) === 0) {
      // No-op for pending/running/done — return the current row if it exists.
      return this.getMemoryJob(id);
    }
    return this.getMemoryJob(id);
  }

  public cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'cancelled', error = COALESCE(?, error), locked_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(options?.reason ?? null, now, id);
    if (Number(result.changes ?? 0) === 0) return this.getMemoryJob(id);
    return this.getMemoryJob(id);
  }

  public sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string }): number {
    const now = options?.now ?? new Date().toISOString();
    const cutoff = new Date(Date.parse(now) - stuckMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'cancelled', error = 'swept: lock expired', locked_at = NULL, updated_at = ?
         WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < ?`,
      )
      .run(now, cutoff);
    return Number(result.changes ?? 0);
  }

  public getMemoryJobKindAggregates(options?: { now?: string }): MemoryJobKindAggregate[] {
    const now = options?.now ?? new Date().toISOString();
    const since24h = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const kinds = (
      this.db.prepare("SELECT DISTINCT kind FROM memory_jobs ORDER BY kind ASC").all() as Array<{
        kind: string;
      }>
    ).map((r) => r.kind);

    return kinds.map((kind) => {
      const latest = this.db
        .prepare(
          `SELECT status, updated_at FROM memory_jobs
           WHERE kind = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(kind) as { status: string; updated_at: string } | undefined;
      const lastCompleted = this.db
        .prepare(
          `SELECT updated_at FROM memory_jobs
           WHERE kind = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(kind) as { updated_at: string } | undefined;
      const pending = this.db
        .prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = ? AND status = 'pending'")
        .get(kind) as { n: number };
      const terminal = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM memory_jobs
           WHERE kind = ? AND updated_at >= ? AND status IN ('done', 'failed')`,
        )
        .get(kind, since24h) as { done: number | null; failed: number | null };
      const done = Number(terminal.done ?? 0);
      const failed = Number(terminal.failed ?? 0);
      const total = done + failed;
      return {
        kind,
        lastStatus: (latest?.status ?? "pending") as MemoryJobStatus,
        lastCompletedAt: lastCompleted?.updated_at ?? null,
        pendingJobs: Number(pending.n ?? 0),
        successRate24h: total > 0 ? done / total : null,
      };
    });
  }

  public sweepActiveSessions(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db
      .prepare("DELETE FROM active_sessions WHERE last_heartbeat_at < ?")
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  private getActiveSession(userId: string, sessionKey: string): ActiveSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
         FROM active_sessions
         WHERE session_key = ? AND user_id = ?`,
      )
      .get(sessionKey, userId) as any;
    return row ? activeSessionRowToRecord(row, true) : null;
  }

  public upsertCoreIdentity(record: CoreIdentityRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO core_identity (user_id, persona_md, cognitive_count_at_generation, created_time, updated_time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        persona_md=excluded.persona_md,
        cognitive_count_at_generation=excluded.cognitive_count_at_generation,
        updated_time=excluded.updated_time
    `);
    stmt.run(record.userId, record.personaMd, record.cognitiveCountAtGeneration, record.createdTime, record.updatedTime);
  }

  public getCoreIdentity(userId: string): CoreIdentityRecord | null {
    const stmt = this.db.prepare("SELECT user_id, persona_md, cognitive_count_at_generation, created_time, updated_time FROM core_identity WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    if (!row) return null;
    return {
      userId: row.user_id, personaMd: row.persona_md,
      cognitiveCountAtGeneration: row.cognitive_count_at_generation,
      createdTime: row.created_time, updatedTime: row.updated_time
    };
  }

  public getIdentityAndInstructionCognitives(userId: string, limit = 100): any[] {
    const stmt = this.db.prepare(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM cognitive_records WHERE user_id = ? AND type IN ('persona','instruction') AND invalid_at IS NULL ORDER BY priority DESC, created_time DESC LIMIT ?"
    );
    return stmt.all(userId, limit) as any[];
  }

  // ============================
  // Scheduler State Methods
  // ============================

  public getSchedulerState(userId: string): SchedulerState {
    const stmt = this.db.prepare("SELECT cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count, extraction_errors, last_error_message, last_error_at FROM scheduler_state WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    if (!row) {
      return {
        cognitiveCountSinceLastFocus: 0,
        cognitiveCountSinceLastIdentity: 0,
        totalCognitiveCount: 0,
        extractionErrors: 0,
        lastErrorMessage: null,
        lastErrorAt: null,
      };
    }
    return {
      cognitiveCountSinceLastFocus: row.cognitive_count_since_last_focus,
      cognitiveCountSinceLastIdentity: row.cognitive_count_since_last_identity,
      totalCognitiveCount: row.total_cognitive_count,
      extractionErrors: row.extraction_errors ?? 0,
      lastErrorMessage: row.last_error_message ?? null,
      lastErrorAt: row.last_error_at ?? null,
    };
  }

  public incrementSchedulerCognitiveCount(userId: string, count: number) {
    const stmt = this.db.prepare(`
      INSERT INTO scheduler_state (user_id, cognitive_count_since_last_focus, cognitive_count_since_last_identity, total_cognitive_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cognitive_count_since_last_focus = cognitive_count_since_last_focus + excluded.cognitive_count_since_last_focus,
        cognitive_count_since_last_identity = cognitive_count_since_last_identity + excluded.cognitive_count_since_last_identity,
        total_cognitive_count = total_cognitive_count + excluded.total_cognitive_count
    `);
    stmt.run(userId, count, count, count);
  }

  public resetSchedulerFocusCount(userId: string) {
    const stmt = this.db.prepare("UPDATE scheduler_state SET cognitive_count_since_last_focus = 0 WHERE user_id = ?");
    stmt.run(userId);
  }

  public resetSchedulerIdentityCount(userId: string) {
    const stmt = this.db.prepare("UPDATE scheduler_state SET cognitive_count_since_last_identity = 0 WHERE user_id = ?");
    stmt.run(userId);
  }

  public recordExtractionFailure(userId: string, message: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        extraction_errors = COALESCE(extraction_errors, 0) + 1,
        last_error_message = excluded.last_error_message,
        last_error_at = excluded.last_error_at
    `);
    stmt.run(userId, message.slice(0, 1000), now);
  }

  public resetExtractionFailures(userId: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO scheduler_state (user_id, extraction_errors, last_error_message, last_error_at)
      VALUES (?, 0, NULL, NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        extraction_errors = 0,
        last_error_message = NULL,
        last_error_at = NULL
    `);
    stmt.run(userId);
  }

  public getExtractionStatus(userId: string): ExtractionStatus {
    const state = this.getSchedulerState(userId);
    return {
      extractionErrors: state.extractionErrors,
      lastErrorMessage: state.lastErrorMessage,
      lastErrorAt: state.lastErrorAt,
      syncPaused: state.extractionErrors >= 5,
    };
  }

  public sweepUnextractedBacklog(options: {
    olderThanMs: number;
    minUnextracted?: number;
    maxFailures?: number;
    limit?: number;
  }): StalledExtractionBacklog[] {
    const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
    const minUnextracted = options.minUnextracted ?? 1;
    const maxFailures = options.maxFailures ?? 5;
    const limit = options.limit ?? 20;

    const rows = this.db.prepare(`
      SELECT
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
      GROUP BY l0.user_id, l0.session_key
      HAVING
        COUNT(*) >= ?
        AND MAX(l0.recorded_at) <= ?
        AND COALESCE(ss.extraction_errors, 0) < ?
      ORDER BY MAX(l0.recorded_at) ASC
      LIMIT ?
    `).all(minUnextracted, cutoff, maxFailures, limit) as any[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionKey: row.session_key,
      sessionId: row.session_id ?? "",
      unextractedCount: row.unextracted_count ?? 0,
      latestRecordedAt: row.latest_recorded_at ?? "",
      extractionErrors: row.extraction_errors ?? 0,
      lastErrorMessage: row.last_error_message ?? null,
    }));
  }

  // ============================
  // GraphRAG Methods
  // ============================

  public getAllGraphNodes(userId: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ?");
    const rows = stmt.all(userId) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, entity: r.entity,
      entityType: r.entity_type, skillTag: r.skill_tag,
      confidence: r.confidence, sourceRecordId: r.source_record_id,
      createdTime: r.created_time
    }));
  }

  public upsertGraphNode(node: GraphNode) {
    const stmt = this.db.prepare(`
      INSERT INTO graph_nodes (id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_type=excluded.entity_type,
        skill_tag=excluded.skill_tag,
        confidence=excluded.confidence,
        source_record_id=excluded.source_record_id
    `);
    stmt.run(
      node.id, node.userId, node.entity, node.entityType, node.skillTag || "",
      node.confidence, node.sourceRecordId, node.createdTime
    );
  }

  public upsertGraphEdge(edge: GraphEdge) {
    const stmt = this.db.prepare(`
      INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, from_node_id, to_node_id, relation) DO UPDATE SET
        skill_tag=excluded.skill_tag,
        confidence=excluded.confidence,
        source_record_id=excluded.source_record_id,
        created_time=excluded.created_time
    `);
    stmt.run(
      edge.id, edge.userId, edge.fromNodeId, edge.toNodeId, edge.relation,
      edge.skillTag || "", edge.confidence, edge.sourceRecordId, edge.createdTime
    );
  }

  public getGraphNodeByEntity(userId: string, entity: string): GraphNode | null {
    const stmt = this.db.prepare(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ? AND LOWER(entity) = LOWER(?)"
    );
    const row = stmt.get(userId, entity) as any;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      entity: row.entity,
      entityType: row.entity_type,
      skillTag: row.skill_tag,
      confidence: row.confidence,
      sourceRecordId: row.source_record_id,
      createdTime: row.created_time
    };
  }

  public getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops = 2): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Map<string, GraphNode>();
    const visitedEdges = new Map<string, GraphEdge>();
    
    const stmtNodeById = this.db.prepare(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ? AND id = ?"
    );
    const startRow = stmtNodeById.get(userId, entityId) as any;
    if (!startRow) return { nodes: [], edges: [] };
    
    const startNode: GraphNode = {
      id: startRow.id,
      userId: startRow.user_id,
      entity: startRow.entity,
      entityType: startRow.entity_type,
      skillTag: startRow.skill_tag,
      confidence: startRow.confidence,
      sourceRecordId: startRow.source_record_id,
      createdTime: startRow.created_time
    };
    visitedNodes.set(startNode.id, startNode);

    let queue = [startNode.id];
    let currentHop = 0;

    while (queue.length > 0 && currentHop < maxHops) {
      const nextQueue: string[] = [];
      
      for (const nodeId of queue) {
        const queryParams: any[] = [userId, nodeId, nodeId];
        
        let edgeSql = `
          SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time
          FROM graph_edges
          WHERE user_id = ? AND (from_node_id = ? OR to_node_id = ?)
        `;
        if (skillTag) {
          edgeSql += " AND (skill_tag = ? OR skill_tag = '')";
          queryParams.push(skillTag);
        }
        
        const stmtEdges = this.db.prepare(edgeSql);
        const edgeRows = stmtEdges.all(...queryParams) as any[];
        
        for (const row of edgeRows) {
          const edge: GraphEdge = {
            id: row.id,
            userId: row.user_id,
            fromNodeId: row.from_node_id,
            toNodeId: row.to_node_id,
            relation: row.relation,
            skillTag: row.skill_tag,
            confidence: row.confidence,
            sourceRecordId: row.source_record_id,
            createdTime: row.created_time
          };
          visitedEdges.set(edge.id, edge);
          
          const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
          if (!visitedNodes.has(neighborId)) {
            const neighborRow = stmtNodeById.get(userId, neighborId) as any;
            if (neighborRow) {
              const neighborNode: GraphNode = {
                id: neighborRow.id,
                userId: neighborRow.user_id,
                entity: neighborRow.entity,
                entityType: neighborRow.entity_type,
                skillTag: neighborRow.skill_tag,
                confidence: neighborRow.confidence,
                sourceRecordId: neighborRow.source_record_id,
                createdTime: neighborRow.created_time
              };
              visitedNodes.set(neighborId, neighborNode);
              nextQueue.push(neighborId);
            }
          }
        }
      }
      
      queue = nextQueue;
      currentHop++;
    }

    return {
      nodes: Array.from(visitedNodes.values()),
      edges: Array.from(visitedEdges.values())
    };
  }

  // ============================
  // ACE Feedback Loop Methods
  // ============================

  public markCited(userId: string, recordIds: string[]): void {
    if (recordIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = recordIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      UPDATE cognitive_records
      SET citation_count = citation_count + 1,
          last_cited_at = ?,
          never_cited_count = 0,
          updated_time = ?
      WHERE user_id = ? AND record_id IN (${placeholders})
    `);
    stmt.run(now, now, userId, ...recordIds);
  }

  public incrementNeverCited(userId: string, recordIds: string[]): { recordId: string; neverCitedCount: number }[] {
    if (recordIds.length === 0) return [];
    const now = new Date().toISOString();
    const placeholders = recordIds.map(() => "?").join(",");

    this.db.prepare(`
      UPDATE cognitive_records
      SET never_cited_count = never_cited_count + 1, updated_time = ?
      WHERE user_id = ? AND record_id IN (${placeholders})
    `).run(now, userId, ...recordIds);

    const rows = this.db.prepare(`
      SELECT record_id, never_cited_count FROM cognitive_records
      WHERE user_id = ? AND record_id IN (${placeholders})
    `).all(userId, ...recordIds) as any[];

    return rows.map(r => ({ recordId: r.record_id, neverCitedCount: r.never_cited_count }));
  }

  public archiveCognitiveRecord(userId: string, recordId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cognitive_records SET archived = 1, status = 'archived', updated_time = ? WHERE user_id = ? AND record_id = ?"
    ).run(now, userId, recordId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "archive",
      actor: "system",
      sessionKey: "",
      reason: "",
      createdAt: now,
      metadata: {},
    });
  }

  // ============================
  // Skill Pre-warming Helpers
  // ============================

  public getRecentSkillContextCognitives(userId: string, limit: number): { skillTag: string; createdTime: string }[] {
    const rows = this.db.prepare(`
      SELECT skill_tag, created_time FROM cognitive_records
      WHERE user_id = ? AND type = 'skill_context' AND skill_tag != '' AND invalid_at IS NULL AND archived = 0
      ORDER BY created_time DESC
      LIMIT ?
    `).all(userId, limit) as any[];
    return rows.map(r => ({ skillTag: r.skill_tag, createdTime: r.created_time }));
  }

  public getSkillHints(skillName: string): string | null {
    const row = this.db.prepare(
      "SELECT hints FROM skill_extraction_hints WHERE skill_name = ?"
    ).get(skillName) as any;
    return row?.hints ?? null;
  }

  public getSkillActivations(userId: string): SkillActivationRecord[] {
    const rows = this.db.prepare(`
      SELECT skill_name, potential, last_decay_time
      FROM skill_activations
      WHERE user_id = ?
      ORDER BY potential DESC, skill_name ASC
    `).all(userId) as any[];
    return rows.map((row) => ({
      skillName: row.skill_name,
      potential: row.potential,
      lastDecayTime: row.last_decay_time,
    }));
  }

  public upsertSkillActivations(userId: string, activations: SkillActivationRecord[]): void {
    if (activations.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO skill_activations (user_id, skill_name, potential, last_decay_time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, skill_name) DO UPDATE SET
        potential=excluded.potential,
        last_decay_time=excluded.last_decay_time
    `);
    this.db.exec("BEGIN");
    try {
      for (const record of activations) {
        stmt.run(userId, record.skillName, record.potential, record.lastDecayTime);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public createUser(userId: string, apiKey: string, displayName = "", isAdmin = false): UserRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (user_id, api_key, password_hash, display_name, email, is_admin, status, created_at)
      VALUES (?, ?, NULL, ?, '', ?, 'active', ?)
    `).run(userId, apiKey, displayName, isAdmin ? 1 : 0, createdAt);
    return {
      userId,
      apiKey,
      passwordHash: null,
      displayName,
      email: "",
      isAdmin,
      status: "active",
      createdAt,
    };
  }

  public getUserByApiKey(apiKey: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE api_key = ?"
    ).get(apiKey) as any;
    if (!row) return null;
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

  public getUserByEmail(email: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE lower(email) = lower(?)"
    ).get(email) as any;
    if (!row) return null;
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

  public getUserById(userId: string): UserRecord | null {
    const row = this.db.prepare(
      "SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE user_id = ?"
    ).get(userId) as any;
    if (!row) return null;
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

  public updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(passwordHash, userId);
  }

  public updateUserEmail(userId: string, email: string): void {
    this.db.prepare("UPDATE users SET email = ? WHERE user_id = ?").run(email, userId);
  }

  public updateUserDisplayName(userId: string, displayName: string): void {
    this.db.prepare("UPDATE users SET display_name = ? WHERE user_id = ?").run(displayName, userId);
  }

  public updateUserStatus(userId: string, status: "active" | "disabled"): void {
    this.db.prepare("UPDATE users SET status = ? WHERE user_id = ?").run(status, userId);
  }

  public updateUserApiKey(userId: string, apiKey: string): void {
    this.db.prepare("UPDATE users SET api_key = ? WHERE user_id = ?").run(apiKey, userId);
  }

  public listUsers(pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): UserRecord[] {
    const where: string[] = [];
    const args: any[] = [];
    if (pagination?.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND user_id > ?))");
      args.push(pagination.cursor.createdAt, pagination.cursor.createdAt, pagination.cursor.userId);
    }
    args.push(pagination?.limit ?? 500);
    const rows = this.db.prepare(
      `SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, user_id ASC
       LIMIT ?`
    ).all(...args) as any[];
    return rows.map((row) => ({
      userId: row.user_id,
      apiKey: row.api_key,
      passwordHash: row.password_hash ?? null,
      displayName: row.display_name ?? "",
      email: row.email ?? "",
      isAdmin: Boolean(row.is_admin),
      status: row.status === "disabled" ? "disabled" : "active",
      createdAt: row.created_at,
    }));
  }

  public deleteUser(userId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM sensory_stream WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_fts WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_records WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM contradictions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM contextual_focus WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM core_identity WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM scheduler_state WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_nodes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_edges WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM cognitive_connections WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_evidence WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_operations WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_file_index WHERE user_id = ?").run(userId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public listMemories(
    userId: string,
    filters?: MemoryListFilters,
    pagination?: CursorPaginationOptions<{ createdTime: string; recordId: string }>
  ): MemoryListItem[] {
    const where: string[] = ["user_id = ?"];
    const args: any[] = [userId];
    if (filters?.query) {
      where.push("content LIKE ?");
      args.push(`%${filters.query}%`);
    }
    if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
    if (filters?.scene) { where.push("scene_name = ?"); args.push(filters.scene); }
    if (filters?.skill) { where.push("skill_tag = ?"); args.push(filters.skill); }
    if (typeof filters?.archived === "boolean") { where.push("archived = ?"); args.push(filters.archived ? 1 : 0); }
    if (pagination?.cursor) {
      where.push("(created_time < ? OR (created_time = ? AND record_id > ?))");
      args.push(pagination.cursor.createdTime, pagination.cursor.createdTime, pagination.cursor.recordId);
    }
    args.push(pagination?.limit ?? 500);

    const rows = this.db.prepare(`
      SELECT record_id, content, type, priority, scene_name, skill_tag, created_time, citation_count, never_cited_count, archived
      FROM cognitive_records
      WHERE ${where.join(" AND ")}
      ORDER BY created_time DESC, record_id ASC
      LIMIT ?
    `).all(...args) as any[];

    return rows.map((row) => ({
      recordId: row.record_id,
      content: row.content,
      type: row.type,
      priority: row.priority,
      sceneName: row.scene_name ?? "",
      skillTag: row.skill_tag ?? "",
      createdTime: row.created_time,
      citationCount: row.citation_count ?? 0,
      neverCitedCount: row.never_cited_count ?? 0,
      archived: Boolean(row.archived),
    }));
  }

  public getMemoryStats(userId: string): {
    total: number;
    archived: number;
    byType: Record<string, number>;
    citationRate: number;
    /**
     * Timestamp of the latest sensory row (MAX of `recorded_at`).
     * Historically named `lastRecallAt` for back-compat with the
     * dashboard /api/stats consumer; kept here under that name to
     * avoid a sweeping rename across packages/types + dashboard.
     */
    lastRecallAt: string | null;
    /**
     * Rows in `sensory_stream` for this user. ALWAYS written on every
     * `memory_capture_turn`. When `total === 0` but `sensoryTotal > 0`
     * the user can tell capture is working but cognitive extraction
     * either hasn't fired yet (extractEveryNTurns=3) or failed silently.
     */
    sensoryTotal: number;
    /** Sensory rows that the cognitive extractor has not consumed yet. */
    sensoryUnextracted: number;
    /** Rows in `contextual_focus` for this user. */
    focusSceneTotal: number;
    extraction: ExtractionStatus;
  } {
    const totalRow = this.db.prepare("SELECT COUNT(*) as c FROM cognitive_records WHERE user_id = ?").get(userId) as any;
    const archivedRow = this.db.prepare("SELECT COUNT(*) as c FROM cognitive_records WHERE user_id = ? AND archived = 1").get(userId) as any;
    const typeRows = this.db.prepare("SELECT type, COUNT(*) as c FROM cognitive_records WHERE user_id = ? GROUP BY type").all(userId) as any[];
    const citationRows = this.db.prepare("SELECT SUM(citation_count) as cited, COUNT(*) as total FROM cognitive_records WHERE user_id = ?").get(userId) as any;
    const sensoryTotalRow = this.db.prepare("SELECT COUNT(*) as c, MAX(recorded_at) as last_at FROM sensory_stream WHERE user_id = ?").get(userId) as any;
    const sensoryUnextractedRow = this.db.prepare(
      "SELECT COUNT(*) as c FROM sensory_stream WHERE user_id = ? AND extracted_at IS NULL"
    ).get(userId) as any;

    const byType: Record<string, number> = {};
    for (const row of typeRows) byType[row.type] = row.c;

    const totalRecords = totalRow?.c ?? 0;
    const cited = citationRows?.cited ?? 0;
    return {
      total: totalRecords,
      archived: archivedRow?.c ?? 0,
      byType,
      citationRate: totalRecords > 0 ? cited / totalRecords : 0,
      lastRecallAt: sensoryTotalRow?.last_at ?? null,
      sensoryTotal: sensoryTotalRow?.c ?? 0,
      sensoryUnextracted: sensoryUnextractedRow?.c ?? 0,
      focusSceneTotal: this.getContextualFocusCount(userId),
      extraction: this.getExtractionStatus(userId),
    };
  }

  private replaceFileIndex(record: CognitiveRecord): void {
    this.db.prepare("DELETE FROM memory_file_index WHERE user_id = ? AND record_id = ?").run(record.userId, record.id);
    const filePaths = [...new Set((record.filePaths ?? []).map((filePath) => filePath.trim()).filter(Boolean))];
    if (filePaths.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO memory_file_index (id, user_id, record_id, file_path, symbol, created_time)
      VALUES (?, ?, ?, ?, '', ?)
    `);
    for (const filePath of filePaths) {
      stmt.run(randomUUID(), record.userId, record.id, filePath, record.createdTime);
    }
  }

  public upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, source_id, target_id) DO UPDATE SET
        weight = excluded.weight,
        last_activated_at = datetime('now')
    `);
    stmt.run(userId, sourceId, targetId, weight);
  }

  public getConnectionsForSource(userId: string, sourceId: string): Array<{ targetId: string; weight: number }> {
    const rows = this.db.prepare(`
      SELECT target_id, weight FROM cognitive_connections
      WHERE user_id = ? AND source_id = ? AND weight >= 0.1
    `).all(userId, sourceId) as any[];
    return rows.map(r => ({ targetId: r.target_id, weight: r.weight }));
  }

  public strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): void {
    if (pairs.length === 0) return;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, source_id, target_id) DO UPDATE SET
          weight = MIN(1.0, weight + ?),
          last_activated_at = datetime('now')
      `);
      for (const pair of pairs) {
        stmt.run(userId, pair.source, pair.target, delta, delta);
        stmt.run(userId, pair.target, pair.source, delta, delta);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public decayConnections(userId: string, decayFactor: number): void {
    const stmt = this.db.prepare(`
      UPDATE cognitive_connections
      SET weight = MAX(0.0, weight * ?)
      WHERE user_id = ?
    `);
    stmt.run(decayFactor, userId);
  }

  public pruneConnections(userId: string, threshold: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM cognitive_connections
      WHERE user_id = ? AND weight < ?
    `);
    stmt.run(userId, threshold);
  }

  public getAllConnections(userId: string): Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }> {
    const rows = this.db.prepare(`
      SELECT source_id, target_id, weight, last_activated_at
      FROM cognitive_connections
      WHERE user_id = ?
    `).all(userId) as any[];
    return rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      weight: r.weight,
      lastActivatedAt: r.last_activated_at ?? "",
    }));
  }
}
