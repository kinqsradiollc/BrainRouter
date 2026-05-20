import { DatabaseSync, StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ContradictionRecord, CursorPaginationOptions, EvidenceListFilters, ExtractionStatus, ImportResult, L0Record, L1Record, L1FtsResult, MemoryEvidence, MemoryExport, MemoryImport, MemoryListFilters, MemoryListItem, MemoryOperation, MemoryStatus, OperationLogFilters, VectorSearchResult, SkillActivationRecord, SkillHintsRecord, L2SceneRecord, L3PersonaRecord, SchedulerState, GraphNode, GraphEdge, StalledExtractionBacklog, UserRecord } from "@brainrouter/types";
import * as sqliteVec from "sqlite-vec";
import type { IMemoryStore } from "@brainrouter/types";

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

function l1RowToRecord(row: any): L1Record {
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

  // L0 statements
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0QueryAfter!: StatementSync;

  // L1 statements
  private stmtL1UpsertMeta!: StatementSync;
  private stmtL1GetMeta!: StatementSync;
  
  // FTS5 statements
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;

  // Vector statements
  private stmtL1VecInsert?: StatementSync;
  private stmtL1VecDelete?: StatementSync;

  private vecLoaded = false;
  private vecDimensions = 0;

  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath, { allowExtension: true });
    } catch (e) {
      throw new Error(`${DB_VERSION_ERROR}\n${e}`);
    }

    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
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
    const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'l1_vec'").get() as any;
    let actualDimensions = -1;
    if (tableInfo && tableInfo.sql) {
      const match = tableInfo.sql.match(/float\[(\d+)\]/i);
      if (match) actualDimensions = parseInt(match[1], 10);
    }

    if (actualDimensions !== -1 && actualDimensions !== dimensions) {
      console.error(`[BrainRouter] Embedding dimensions changed (${actualDimensions} -> ${dimensions}). Recreating vector tables.`);
      // Drop all shadow tables explicitly to avoid sqlite-vec edge cases, then drop the virtual table
      try {
        this.db.exec("DROP TABLE IF EXISTS l1_vec");
      } catch (e) {
        console.warn("[BrainRouter] Error dropping l1_vec:", e);
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
      CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
        record_id TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      )
    `);

    this.stmtL1VecInsert = this.db.prepare("INSERT INTO l1_vec (record_id, embedding) VALUES (?, ?)");
    this.stmtL1VecDelete = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
  }

  public isVecAvailable(): boolean {
    return this.vecLoaded && this.vecDimensions > 0;
  }

  public async reembedStaleRecords(embedder: (text: string) => Promise<Float32Array>): Promise<number> {
    if (!this.vecLoaded) return 0;

    const rows = this.db.prepare(`
      SELECT r.record_id, r.content
      FROM l1_records r
      LEFT JOIN l1_vec v ON r.record_id = v.record_id
      WHERE r.invalid_at IS NULL
        AND r.archived = 0
        AND v.record_id IS NULL
      ORDER BY r.created_time ASC, r.record_id ASC
    `).all() as Array<{ record_id: string; content: string }>;

    let successCount = 0;
    for (const row of rows) {
      try {
        const embedding = await embedder(row.content);
        this.upsertL1Vec(row.record_id, embedding);
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
    // ── L0 Schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
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
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN extracted_at TEXT DEFAULT NULL");
    } catch (_) {
      // Column already exists, ignore
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_user_session ON l0_conversations(user_id, session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_extracted ON l0_conversations(user_id, session_key, extracted_at)");

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
    const userColumns = [
      "ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'",
    ];
    for (const sql of userColumns) {
      try { this.db.exec(sql); } catch { /* column exists */ }
    }

    this.stmtL0UpsertMeta = this.db.prepare(`
      INSERT INTO l0_conversations (
        record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id as id, user_id as userId, session_key as sessionKey, session_id as sessionId,
             role, message_text as messageText, recorded_at as recordedAt, timestamp, skill_tag as skillTag
      FROM l0_conversations
      WHERE user_id = ? AND session_key = ? AND recorded_at > ? AND extracted_at IS NULL
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    // ── L1 Schema ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
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
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    try {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN invalid_at TEXT DEFAULT NULL");
    } catch (_) {
      // Column already exists, ignore
    }

    // ── ACE Feedback Loop columns — added before prepared statements so queries can reference them ──
    const aceColumns = [
      "ALTER TABLE l1_records ADD COLUMN citation_count INTEGER DEFAULT 0",
      "ALTER TABLE l1_records ADD COLUMN last_cited_at TEXT",
      "ALTER TABLE l1_records ADD COLUMN never_cited_count INTEGER DEFAULT 0",
      "ALTER TABLE l1_records ADD COLUMN archived INTEGER DEFAULT 0",
    ];
    for (const sql of aceColumns) {
      try { this.db.exec(sql); } catch { /* column already exists — safe to ignore */ }
    }

    const trustColumns = [
      "ALTER TABLE l1_records ADD COLUMN confidence REAL DEFAULT 0.65",
      "ALTER TABLE l1_records ADD COLUMN status TEXT DEFAULT 'active'",
      "ALTER TABLE l1_records ADD COLUMN source_kind TEXT DEFAULT ''",
      "ALTER TABLE l1_records ADD COLUMN verification_status TEXT DEFAULT ''",
      "ALTER TABLE l1_records ADD COLUMN repo_paths_json TEXT DEFAULT '[]'",
      "ALTER TABLE l1_records ADD COLUMN file_paths_json TEXT DEFAULT '[]'",
      "ALTER TABLE l1_records ADD COLUMN commands_json TEXT DEFAULT '[]'",
    ];
    for (const sql of trustColumns) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

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

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_type ON l1_records(user_id, type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_session ON l1_records(user_id, session_key)");

    this.stmtL1UpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, user_id, session_key, session_id, content, type, priority, scene_name, skill_tag,
        half_life_days, superseded_by, invalid_at, timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json, confidence, status, source_kind, verification_status,
        repo_paths_json, file_paths_json, commands_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        commands_json=excluded.commands_json
        -- NOTE: citation_count, last_cited_at, never_cited_count, archived intentionally excluded
        -- They are managed exclusively by ACE methods (markCited, incrementNeverCited, archiveL1Record)
        -- to prevent re-upserts from resetting citation signals
    `);

    this.stmtL1GetMeta = this.db.prepare(`
      SELECT * FROM l1_records WHERE record_id = ? AND user_id = ?
    `);

    // ── L1 FTS5 Schema ──
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
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

    this.stmtL1FtsInsert = this.db.prepare(`
      INSERT INTO l1_fts (
        content, content_original, record_id, user_id, type, priority, scene_name,
        skill_tag, session_key, timestamp_str, created_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtL1FtsSearch = this.db.prepare(`
      SELECT 
        f.record_id, f.user_id, f.content_original as content, f.type, f.priority, f.scene_name,
        f.skill_tag, f.session_key, f.timestamp_str, f.created_time,
        f.rank, r.citation_count
      FROM l1_fts f
      JOIN l1_records r ON f.record_id = r.record_id
      WHERE f.user_id = ? AND l1_fts MATCH ? AND r.invalid_at IS NULL AND r.archived = 0
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

    // ── L2 Scene Narratives ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l2_scenes (
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
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l2_user_heat ON l2_scenes(user_id, heat_score DESC)");

    // ── L3 Persona ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l3_persona (
        user_id TEXT PRIMARY KEY,
        persona_md TEXT NOT NULL,
        l1_count_at_generation INTEGER DEFAULT 0,
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT ''
      )
    `);

    // ── Scheduler State ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        user_id TEXT PRIMARY KEY,
        l1_count_since_last_l2 INTEGER DEFAULT 0,
        l1_count_since_last_l3 INTEGER DEFAULT 0,
        total_l1_count INTEGER DEFAULT 0,
        extraction_errors INTEGER DEFAULT 0,
        last_error_message TEXT DEFAULT NULL,
        last_error_at TEXT DEFAULT NULL
      )
    `);
    const schedulerColumns = [
      "ALTER TABLE scheduler_state ADD COLUMN extraction_errors INTEGER DEFAULT 0",
      "ALTER TABLE scheduler_state ADD COLUMN last_error_message TEXT DEFAULT NULL",
      "ALTER TABLE scheduler_state ADD COLUMN last_error_at TEXT DEFAULT NULL",
    ];
    for (const sql of schedulerColumns) {
      try { this.db.exec(sql); } catch { /* column exists */ }
    }

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
  }

  // ============================
  // L0 Methods
  // ============================

  public upsertL0(record: L0Record) {
    this.db.exec("BEGIN");
    try {
      this.stmtL0UpsertMeta.run(
        record.id, record.userId, record.sessionKey, record.sessionId, record.role,
        record.messageText, record.recordedAt, record.timestamp, record.skillTag
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public getRecentL0Messages(userId: string, sessionKey: string, limit: number, afterIsoTime = ""): L0Record[] {
    const rows = this.stmtL0QueryAfter.all(userId, sessionKey, afterIsoTime, limit) as any[];
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

  public getUnextractedL0Count(userId: string, sessionKey: string): number {
    const stmtCount = this.db.prepare("SELECT COUNT(*) as count FROM l0_conversations WHERE user_id = ? AND session_key = ? AND extracted_at IS NULL");
    const row = stmtCount.get(userId, sessionKey) as any;
    return row?.count || 0;
  }

  public markL0Extracted(userId: string, sessionKey: string, recordIds: string[], extractedAt = new Date().toISOString()): void {
    if (recordIds.length === 0) return;

    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare("UPDATE l0_conversations SET extracted_at = ? WHERE user_id = ? AND session_key = ? AND record_id = ?");
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
  // L1 Methods
  // ============================

  public upsertL1Batch(entries: Array<{ record: L1Record; embedding?: Float32Array }>, options?: { skipAudit?: boolean }) {
    this.db.exec("BEGIN");
    try {
      const deleteFts = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ? AND user_id = ?");
      for (const entry of entries) {
        const record = entry.record;
        this.stmtL1UpsertMeta.run(
          record.id, record.userId, record.sessionKey, record.sessionId, record.content,
          record.type, record.priority, record.sceneName, record.skillTag,
          record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
          record.timestampStart, record.timestampEnd, record.createdTime,
          record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
          record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
          JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
          JSON.stringify(record.commands ?? [])
        );

        // FTS5 Insert
        deleteFts.run(record.id, record.userId);
        this.stmtL1FtsInsert.run(
          record.content, record.content, record.id, record.userId, record.type,
          record.priority, record.sceneName, record.skillTag, record.sessionKey,
          record.timestampStr, record.createdTime
        );

        // Vector Insert
        if (entry.embedding && this.vecLoaded && this.stmtL1VecInsert && this.stmtL1VecDelete) {
          this.stmtL1VecDelete.run(record.id);
          this.stmtL1VecInsert.run(record.id, entry.embedding);
        }
        this.replaceFileIndex(record);

        // skipAudit suppresses per-record l1_upsert noise; callers (e.g. extraction pipeline)
        // should write one higher-level batch audit entry after the loop instead.
        if (!options?.skipAudit) {
          this.insertOperation({
            id: randomUUID(),
            userId: record.userId,
            recordId: record.id,
            operation: "l1_upsert",
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

  public upsertL1(record: L1Record, options?: { skipAudit?: boolean }) {
    this.db.exec("BEGIN");
    try {
      this.stmtL1UpsertMeta.run(
        record.id, record.userId, record.sessionKey, record.sessionId, record.content,
        record.type, record.priority, record.sceneName, record.skillTag,
        record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
        record.timestampStart, record.timestampEnd, record.createdTime,
        record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
        record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
        JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
        JSON.stringify(record.commands ?? [])
      );

      // FTS5 Insert (delete old first if it exists to emulate UPSERT)
      const deleteFts = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ? AND user_id = ?");
      deleteFts.run(record.id, record.userId);
      
      this.stmtL1FtsInsert.run(
        record.content, record.content, record.id, record.userId, record.type,
        record.priority, record.sceneName, record.skillTag, record.sessionKey,
        record.timestampStr, record.createdTime
      );
      this.replaceFileIndex(record);

      // skipAudit: true suppresses the automatic l1_upsert op so callers that
      // write their own higher-level operation (e.g. memory_update) don't produce
      // a redundant audit row for every upsert they perform.
      if (!options?.skipAudit) {
        this.insertOperation({
          id: randomUUID(),
          userId: record.userId,
          recordId: record.id,
          operation: "l1_upsert",
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

  public invalidateL1Record(userId: string, recordId: string, supersededById: string) {
    const stmt = this.db.prepare(
      "UPDATE l1_records SET invalid_at = ?, superseded_by = ?, status = 'superseded' WHERE user_id = ? AND record_id = ?"
    );
    const now = new Date().toISOString();
    stmt.run(now, supersededById, userId, recordId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "l1_supersede",
      actor: "system",
      sessionKey: "",
      reason: `Superseded by ${supersededById}`,
      createdAt: now,
      metadata: { supersededById },
    });
  }

  public getMemoryById(userId: string, recordId: string): L1Record | null {
    const row = this.stmtL1GetMeta.get(recordId, userId) as any;
    return row ? l1RowToRecord(row) : null;
  }

  public getMemoriesByFilePath(userId: string, filePath: string, limit: number): L1Record[] {
    const rows = this.db.prepare(`
      SELECT r.*
      FROM memory_file_index i
      JOIN l1_records r ON r.user_id = i.user_id AND r.record_id = i.record_id
      WHERE i.user_id = ?
        AND (i.file_path = ? OR i.file_path LIKE ?)
        AND r.invalid_at IS NULL
        AND r.archived = 0
      ORDER BY i.created_time DESC, r.priority DESC
      LIMIT ?
    `).all(userId, filePath, `%${filePath}%`, limit) as any[];
    return rows.map(l1RowToRecord);
  }

  public updateL1Confidence(userId: string, recordId: string, confidence: number, status: MemoryStatus): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE l1_records SET confidence = ?, status = ?, archived = CASE WHEN ? = 'archived' THEN 1 ELSE archived END, updated_time = ? WHERE user_id = ? AND record_id = ?"
    ).run(confidence, status, status, now, userId, recordId);
    this.insertOperation({
      id: randomUUID(),
      userId,
      recordId,
      operation: "l1_status_update",
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
      // ORDER BY created_at DESC, id ASC:
      // Next page = rows with an earlier timestamp, OR same timestamp with a higher id
      // (id is sorted ASC within a timestamp, so the next rows in the same bucket have id > cursor.id).
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
    const memoryRows = this.db.prepare("SELECT * FROM l1_records WHERE user_id = ? ORDER BY created_time ASC, record_id ASC").all(userId) as any[];
    const evidenceRows = this.db.prepare("SELECT * FROM memory_evidence WHERE user_id = ? ORDER BY observed_at ASC, id ASC").all(userId) as any[];
    const operationRows = this.db.prepare("SELECT * FROM memory_operations WHERE user_id = ? ORDER BY created_at ASC, id ASC").all(userId) as any[];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      userId,
      memories: memoryRows.map(l1RowToRecord),
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
        this.stmtL1UpsertMeta.run(
          record.id, userId, record.sessionKey, record.sessionId, record.content,
          record.type, record.priority, record.sceneName, record.skillTag,
          record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
          record.timestampStart, record.timestampEnd, record.createdTime,
          record.updatedTime, JSON.stringify(record.metadata ?? {}), record.confidence ?? 0.65,
          record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
          JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
          JSON.stringify(record.commands ?? [])
        );
        this.db.prepare("DELETE FROM l1_fts WHERE record_id = ? AND user_id = ?").run(record.id, userId);
        this.stmtL1FtsInsert.run(
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
      this.db.prepare("DELETE FROM l1_fts WHERE user_id = ? AND record_id = ?").run(userId, recordId);
      if (this.stmtL1VecDelete) {
        this.stmtL1VecDelete.run(recordId);
      }
      this.db.prepare("DELETE FROM l1_records WHERE user_id = ? AND record_id = ?").run(userId, recordId);
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

  public searchL1Fts(userId: string, query: string, limit: number): L1FtsResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.stmtL1FtsSearch.all(userId, ftsQuery, limit) as any[];
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

  /**
   * Point-in-time FTS search: returns memories that existed AND were valid at `asOf` ISO timestamp.
   * Surfaces what the engine "knew" at a specific moment in time.
   */
  public searchL1FtsAsOf(userId: string, query: string, limit: number, asOf: string): L1FtsResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const stmt = this.db.prepare(`
      SELECT 
        f.record_id, f.user_id, f.content_original as content, f.type, f.priority, f.scene_name,
        f.skill_tag, f.session_key, f.timestamp_str, f.created_time,
        f.rank
      FROM l1_fts f
      JOIN l1_records r ON f.record_id = r.record_id
      WHERE f.user_id = ?
        AND l1_fts MATCH ?
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

  public upsertL1Vec(recordId: string, embedding: Float32Array) {
    if (!this.vecLoaded) return;
    
    // Lazy schema recreation if dimensions dynamically shift from API
    if (this.vecDimensions !== embedding.length) {
      this.initVec(embedding.length);
    }

    if (!this.stmtL1VecInsert || !this.stmtL1VecDelete) return;
    
    this.db.exec("BEGIN");
    try {
      // vec0 doesn't support ON CONFLICT
      this.stmtL1VecDelete.run(recordId);
      this.stmtL1VecInsert.run(recordId, embedding);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  public searchL1Vec(userId: string, queryEmbedding: Float32Array, limit: number): VectorSearchResult[] {
    if (!this.vecLoaded) return [];

    // Lazy schema recreation if dimensions dynamically shift from API
    if (this.vecDimensions !== queryEmbedding.length) {
      this.initVec(queryEmbedding.length);
    }

    if (!this.vecDimensions) return [];

    // vec0 cosine search
    const stmt = this.db.prepare(`
      SELECT 
        v.record_id, v.distance,
        r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
        r.session_key, r.timestamp_str, r.created_time
      FROM l1_vec v
      JOIN l1_records r ON v.record_id = r.record_id
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
        score: 1 - r.distance, // Convert distance to similarity score
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
      JOIN l1_records r1 ON c.record_id_a = r1.record_id
      JOIN l1_records r2 ON c.record_id_b = r2.record_id
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
  // L2 Scene Methods
  // ============================

  public upsertL2Scene(record: L2SceneRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO l2_scenes (id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time)
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

  public getTopL2Scenes(userId: string, limit = 3, cursor?: { heatScore: number; id: string }): L2SceneRecord[] {
    const where = ["user_id = ?"];
    const args: any[] = [userId];
    if (cursor) {
      where.push("(heat_score < ? OR (heat_score = ? AND id > ?))");
      args.push(cursor.heatScore, cursor.heatScore, cursor.id);
    }
    args.push(limit);
    const stmt = this.db.prepare(
      `SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time
       FROM l2_scenes
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

  public decayL2HeatScores(userId: string, decayFactor = 0.95) {
    const stmt = this.db.prepare("UPDATE l2_scenes SET heat_score = heat_score * ? WHERE user_id = ?");
    stmt.run(decayFactor, userId);
  }

  public boostL2HeatScore(userId: string, sceneName: string, boost = 20) {
    const stmt = this.db.prepare("UPDATE l2_scenes SET heat_score = MIN(100.0, heat_score + ?), last_active_time = ? WHERE user_id = ? AND scene_name = ?");
    stmt.run(boost, new Date().toISOString(), userId, sceneName);
  }

  public getL1sByScene(userId: string, sceneName: string, limit = 30): any[] {
    const stmt = this.db.prepare(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM l1_records WHERE user_id = ? AND scene_name = ? AND invalid_at IS NULL ORDER BY priority DESC LIMIT ?"
    );
    return stmt.all(userId, sceneName, limit) as any[];
  }

  public getL2SceneCount(userId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM l2_scenes WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    return row?.count || 0;
  }

  public getColdL2Scenes(userId: string, limit: number): L2SceneRecord[] {
    const stmt = this.db.prepare(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM l2_scenes WHERE user_id = ? ORDER BY heat_score ASC LIMIT ?"
    );
    const rows = stmt.all(userId, limit) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, sceneName: r.scene_name,
      summaryMd: r.summary_md, heatScore: r.heat_score,
      lastActiveTime: r.last_active_time, createdTime: r.created_time, updatedTime: r.updated_time
    }));
  }

  public deleteL2Scenes(userId: string, sceneIds: string[]) {
    if (sceneIds.length === 0) return;
    const placeholders = sceneIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`DELETE FROM l2_scenes WHERE user_id = ? AND id IN (${placeholders})`);
    stmt.run(userId, ...sceneIds);
  }

  public getL2SceneByName(userId: string, sceneName: string): L2SceneRecord | null {
    const stmt = this.db.prepare(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM l2_scenes WHERE user_id = ? AND scene_name = ?"
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
    const stmt = this.db.prepare("SELECT DISTINCT scene_name FROM l1_records WHERE user_id = ? AND scene_name != ''");
    const rows = stmt.all(userId) as any[];
    return rows.map(r => r.scene_name);
  }

  public renameSceneInL1Records(userId: string, oldName: string, canonicalName: string) {
    this.db.exec("BEGIN");
    try {
      // 1. Update all L1 records using this scene name
      const stmtUpdateL1 = this.db.prepare(
        "UPDATE l1_records SET scene_name = ?, updated_time = ? WHERE user_id = ? AND scene_name = ?"
      );
      stmtUpdateL1.run(canonicalName, new Date().toISOString(), userId, oldName);

      // 2. Remove the old scene record from l2_scenes so it doesn't linger
      const stmtDeleteL2 = this.db.prepare(
        "DELETE FROM l2_scenes WHERE user_id = ? AND scene_name = ?"
      );
      stmtDeleteL2.run(userId, oldName);

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ============================
  // L3 Persona Methods
  // ============================

  public upsertL3Persona(record: L3PersonaRecord) {
    const stmt = this.db.prepare(`
      INSERT INTO l3_persona (user_id, persona_md, l1_count_at_generation, created_time, updated_time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        persona_md=excluded.persona_md,
        l1_count_at_generation=excluded.l1_count_at_generation,
        updated_time=excluded.updated_time
    `);
    stmt.run(record.userId, record.personaMd, record.l1CountAtGeneration, record.createdTime, record.updatedTime);
  }

  public getL3Persona(userId: string): L3PersonaRecord | null {
    const stmt = this.db.prepare("SELECT user_id, persona_md, l1_count_at_generation, created_time, updated_time FROM l3_persona WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    if (!row) return null;
    return {
      userId: row.user_id, personaMd: row.persona_md,
      l1CountAtGeneration: row.l1_count_at_generation,
      createdTime: row.created_time, updatedTime: row.updated_time
    };
  }

  public getPersonaAndInstructionL1s(userId: string, limit = 100): any[] {
    const stmt = this.db.prepare(
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM l1_records WHERE user_id = ? AND type IN ('persona','instruction') AND invalid_at IS NULL ORDER BY priority DESC, created_time DESC LIMIT ?"
    );
    return stmt.all(userId, limit) as any[];
  }

  // ============================
  // Scheduler State Methods
  // ============================

  public getSchedulerState(userId: string): SchedulerState {
    const stmt = this.db.prepare("SELECT l1_count_since_last_l2, l1_count_since_last_l3, total_l1_count, extraction_errors, last_error_message, last_error_at FROM scheduler_state WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    if (!row) {
      return {
        l1CountSinceLastL2: 0,
        l1CountSinceLastL3: 0,
        totalL1Count: 0,
        extractionErrors: 0,
        lastErrorMessage: null,
        lastErrorAt: null,
      };
    }
    return {
      l1CountSinceLastL2: row.l1_count_since_last_l2,
      l1CountSinceLastL3: row.l1_count_since_last_l3,
      totalL1Count: row.total_l1_count,
      extractionErrors: row.extraction_errors ?? 0,
      lastErrorMessage: row.last_error_message ?? null,
      lastErrorAt: row.last_error_at ?? null,
    };
  }

  public incrementSchedulerL1Count(userId: string, count: number) {
    const stmt = this.db.prepare(`
      INSERT INTO scheduler_state (user_id, l1_count_since_last_l2, l1_count_since_last_l3, total_l1_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        l1_count_since_last_l2 = l1_count_since_last_l2 + excluded.l1_count_since_last_l2,
        l1_count_since_last_l3 = l1_count_since_last_l3 + excluded.l1_count_since_last_l3,
        total_l1_count = total_l1_count + excluded.total_l1_count
    `);
    stmt.run(userId, count, count, count);
  }

  public resetSchedulerL2Count(userId: string) {
    const stmt = this.db.prepare("UPDATE scheduler_state SET l1_count_since_last_l2 = 0 WHERE user_id = ?");
    stmt.run(userId);
  }

  public resetSchedulerL3Count(userId: string) {
    const stmt = this.db.prepare("UPDATE scheduler_state SET l1_count_since_last_l3 = 0 WHERE user_id = ?");
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
      FROM l0_conversations l0
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
    
    // Look up the starting node
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
        // Query edges from/to this node
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

  /**
   * Mark a set of record IDs as cited — increments citation_count, sets last_cited_at,
   * and resets never_cited_count to 0 (a citation cancels accumulated non-citation signal).
   */
  public markCited(userId: string, recordIds: string[]): void {
    if (recordIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = recordIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      UPDATE l1_records
      SET citation_count = citation_count + 1,
          last_cited_at = ?,
          never_cited_count = 0,
          updated_time = ?
      WHERE user_id = ? AND record_id IN (${placeholders})
    `);
    stmt.run(now, now, userId, ...recordIds);
  }

  /**
   * Increment never_cited_count for records that were recalled but NOT cited.
   * Returns the updated never_cited_count for each affected record (used for auto-archive).
   */
  public incrementNeverCited(userId: string, recordIds: string[]): { recordId: string; neverCitedCount: number }[] {
    if (recordIds.length === 0) return [];
    const now = new Date().toISOString();
    const placeholders = recordIds.map(() => "?").join(",");

    this.db.prepare(`
      UPDATE l1_records
      SET never_cited_count = never_cited_count + 1, updated_time = ?
      WHERE user_id = ? AND record_id IN (${placeholders})
    `).run(now, userId, ...recordIds);

    const rows = this.db.prepare(`
      SELECT record_id, never_cited_count FROM l1_records
      WHERE user_id = ? AND record_id IN (${placeholders})
    `).all(userId, ...recordIds) as any[];

    return rows.map(r => ({ recordId: r.record_id, neverCitedCount: r.never_cited_count }));
  }

  /**
   * Archive a single L1 record — excluded from future active recall queries.
   * The record is preserved for explicit archive queries.
   */
  public archiveL1Record(userId: string, recordId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE l1_records SET archived = 1, status = 'archived', updated_time = ? WHERE user_id = ? AND record_id = ?"
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

  /**
   * Get the most recent N skill_context L1 records for a user.
   * Used by the skill pre-warming pipeline to detect recent skill patterns.
   */
  public getRecentSkillContextL1s(userId: string, limit: number): { skillTag: string; createdTime: string }[] {
    const rows = this.db.prepare(`
      SELECT skill_tag, created_time FROM l1_records
      WHERE user_id = ? AND type = 'skill_context' AND skill_tag != '' AND invalid_at IS NULL AND archived = 0
      ORDER BY created_time DESC
      LIMIT ?
    `).all(userId, limit) as any[];
    return rows.map(r => ({ skillTag: r.skill_tag, createdTime: r.created_time }));
  }

  /**
   * Get the registered extraction hints for a specific skill name.
   * Returns null if no hints are registered.
   */
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
      this.db.prepare("DELETE FROM l0_conversations WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM l1_fts WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM l1_records WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM contradictions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM l2_scenes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM l3_persona WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM scheduler_state WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_nodes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM graph_edges WHERE user_id = ?").run(userId);
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
      FROM l1_records
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
    lastRecallAt: string | null;
    extraction: ExtractionStatus;
  } {
    const totalRow = this.db.prepare("SELECT COUNT(*) as c FROM l1_records WHERE user_id = ?").get(userId) as any;
    const archivedRow = this.db.prepare("SELECT COUNT(*) as c FROM l1_records WHERE user_id = ? AND archived = 1").get(userId) as any;
    const typeRows = this.db.prepare("SELECT type, COUNT(*) as c FROM l1_records WHERE user_id = ? GROUP BY type").all(userId) as any[];
    const citationRows = this.db.prepare("SELECT SUM(citation_count) as cited, COUNT(*) as total FROM l1_records WHERE user_id = ?").get(userId) as any;
    const lastRecall = this.db.prepare(
      "SELECT MAX(recorded_at) as last_at FROM l0_conversations WHERE user_id = ?"
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
      lastRecallAt: lastRecall?.last_at ?? null,
      extraction: this.getExtractionStatus(userId),
    };
  }

  private replaceFileIndex(record: L1Record): void {
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
}
