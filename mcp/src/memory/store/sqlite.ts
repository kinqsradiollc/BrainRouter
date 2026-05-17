import { DatabaseSync, StatementSync } from "node:sqlite";
import type { L0Record, L1Record, L1FtsResult, VectorSearchResult, SkillHintsRecord, L2SceneRecord, L3PersonaRecord, SchedulerState } from "../types.js";
import * as sqliteVec from "sqlite-vec";

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

export class SqliteMemoryStore {
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

    // Check if dimensions changed
    const metaRow = this.db.prepare("SELECT dimensions FROM embedding_meta WHERE id = 1").get() as any;
    if (metaRow && metaRow.dimensions !== dimensions) {
      console.error(`[BrainRouter] Embedding dimensions changed (${metaRow.dimensions} -> ${dimensions}). Recreating vector tables.`);
      this.db.exec("DROP TABLE IF EXISTS l1_vec");
      this.db.prepare("UPDATE embedding_meta SET dimensions = ?, created_at = ? WHERE id = 1")
        .run(dimensions, new Date().toISOString());
    } else if (!metaRow) {
      this.db.prepare("INSERT INTO embedding_meta (id, dimensions, created_at) VALUES (1, ?, ?)")
        .run(dimensions, new Date().toISOString());
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
        skill_tag TEXT DEFAULT ''
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_user_session ON l0_conversations(user_id, session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");

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
      WHERE user_id = ? AND session_key = ? AND recorded_at > ?
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
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_type ON l1_records(user_id, type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_user_session ON l1_records(user_id, session_key)");

    this.stmtL1UpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, user_id, session_key, session_id, content, type, priority, scene_name, skill_tag,
        half_life_days, superseded_by, timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        skill_tag=excluded.skill_tag,
        half_life_days=excluded.half_life_days,
        superseded_by=excluded.superseded_by,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json
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
        record_id, user_id, content_original as content, type, priority, scene_name,
        skill_tag, session_key, timestamp_str, created_time,
        rank
      FROM l1_fts
      WHERE user_id = ? AND l1_fts MATCH ?
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
        total_l1_count INTEGER DEFAULT 0
      )
    `);
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
    const stmtLatestL1 = this.db.prepare("SELECT MAX(created_time) as maxTime FROM l1_records WHERE user_id = ? AND session_key = ?");
    const latestL1 = stmtLatestL1.get(userId, sessionKey) as any;
    const lastExtractionTime = latestL1?.maxTime || "";

    const stmtCount = this.db.prepare("SELECT COUNT(*) as count FROM l0_conversations WHERE user_id = ? AND session_key = ? AND recorded_at > ?");
    const row = stmtCount.get(userId, sessionKey, lastExtractionTime) as any;
    return row?.count || 0;
  }

  // ============================
  // L1 Methods
  // ============================

  public upsertL1(record: L1Record) {
    this.db.exec("BEGIN");
    try {
      this.stmtL1UpsertMeta.run(
        record.id, record.userId, record.sessionKey, record.sessionId, record.content,
        record.type, record.priority, record.sceneName, record.skillTag,
        record.halfLifeDays, record.supersededBy, record.timestampStr,
        record.timestampStart, record.timestampEnd, record.createdTime,
        record.updatedTime, JSON.stringify(record.metadata)
      );

      // FTS5 Insert (delete old first if it exists to emulate UPSERT)
      const deleteFts = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ? AND user_id = ?");
      deleteFts.run(record.id, record.userId);
      
      this.stmtL1FtsInsert.run(
        record.content, record.content, record.id, record.userId, record.type,
        record.priority, record.sceneName, record.skillTag, record.sessionKey,
        record.timestampStr, record.createdTime
      );

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
      created_time: r.created_time
    }));
  }

  public upsertL1Vec(recordId: string, embedding: Float32Array) {
    if (!this.vecLoaded || !this.stmtL1VecInsert || !this.stmtL1VecDelete) return;
    
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
    if (!this.vecLoaded || !this.vecDimensions) return [];

    // vec0 cosine search
    const stmt = this.db.prepare(`
      SELECT 
        v.record_id, v.distance,
        r.user_id, r.content, r.type, r.priority, r.scene_name, r.skill_tag,
        r.session_key, r.timestamp_str, r.created_time
      FROM l1_vec v
      JOIN l1_records r ON v.record_id = r.record_id
      WHERE v.embedding MATCH ? AND k = ? AND r.user_id = ?
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

  public getPendingContradictions(userId: string) {
    const stmt = this.db.prepare(`
      SELECT c.*, r1.content as content_a, r2.content as content_b
      FROM contradictions c
      JOIN l1_records r1 ON c.record_id_a = r1.record_id
      JOIN l1_records r2 ON c.record_id_b = r2.record_id
      WHERE c.user_id = ? AND c.status = 'pending'
      ORDER BY c.confidence DESC
    `);
    return stmt.all(userId);
  }

  public resolveContradiction(id: string, userId: string, status: 'resolved' | 'dismissed') {
    const stmt = this.db.prepare("UPDATE contradictions SET status = ? WHERE id = ? AND user_id = ?");
    stmt.run(status, id, userId);
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

  public getSkillHints(skillName: string): string | null {
    const stmt = this.db.prepare("SELECT hints FROM skill_extraction_hints WHERE skill_name = ?");
    const row = stmt.get(skillName) as any;
    return row ? row.hints : null;
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

  public getTopL2Scenes(userId: string, limit = 3): L2SceneRecord[] {
    const stmt = this.db.prepare(
      "SELECT id, user_id, scene_name, summary_md, heat_score, last_active_time, created_time, updated_time FROM l2_scenes WHERE user_id = ? ORDER BY heat_score DESC LIMIT ?"
    );
    const rows = stmt.all(userId, limit) as any[];
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
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM l1_records WHERE user_id = ? AND scene_name = ? ORDER BY priority DESC LIMIT ?"
    );
    return stmt.all(userId, sceneName, limit) as any[];
  }

  public getDistinctSceneNames(userId: string): string[] {
    const stmt = this.db.prepare("SELECT DISTINCT scene_name FROM l1_records WHERE user_id = ? AND scene_name != ''");
    const rows = stmt.all(userId) as any[];
    return rows.map(r => r.scene_name);
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
      "SELECT record_id, content, type, priority, skill_tag, created_time FROM l1_records WHERE user_id = ? AND type IN ('persona','instruction') ORDER BY priority DESC, created_time DESC LIMIT ?"
    );
    return stmt.all(userId, limit) as any[];
  }

  // ============================
  // Scheduler State Methods
  // ============================

  public getSchedulerState(userId: string): SchedulerState {
    const stmt = this.db.prepare("SELECT l1_count_since_last_l2, l1_count_since_last_l3, total_l1_count FROM scheduler_state WHERE user_id = ?");
    const row = stmt.get(userId) as any;
    if (!row) return { l1CountSinceLastL2: 0, l1CountSinceLastL3: 0, totalL1Count: 0 };
    return {
      l1CountSinceLastL2: row.l1_count_since_last_l2,
      l1CountSinceLastL3: row.l1_count_since_last_l3,
      totalL1Count: row.total_l1_count
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
}
