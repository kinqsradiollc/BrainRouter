/**
 * Cognitive-record SQL (verbatim extraction from `PostgresMemoryStore`).
 *
 * Covers the `cognitive_records` write path (upsert meta, file-index rebuild,
 * batch/single upserts, invalidate, confidence) plus the record-level reads
 * (by id / file path / lesson lookups) and the ACE feedback-loop mutations.
 * SQL text is unchanged; the private `this.rows/one/run/tx` calls became
 * `exec.*` and cross-method calls take the same free functions.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CognitiveRecord,
  MemoryOperation,
  MemoryStatus,
} from "@kinqs/brainrouter-types";
import { cognitiveRowToRecord, toVectorLiteral, asNumber } from "../converters.js";
import type { Executor } from "./executor.js";
import { insertOperation } from "./operationsQueries.js";

export function cognitiveUpsertParams(record: CognitiveRecord): any[] {
  return [
    record.id, record.userId, record.sessionKey, record.sessionId, record.content,
    record.type, record.priority, record.sceneName, record.skillTag,
    record.halfLifeDays, record.supersededBy, record.invalidAt || null, record.timestampStr,
    record.timestampStart, record.timestampEnd, record.createdTime,
    record.updatedTime, JSON.stringify(record.metadata), record.confidence ?? 0.65,
    record.status ?? "active", record.sourceKind ?? "", record.verificationStatus ?? "",
    JSON.stringify(record.repoPaths ?? []), JSON.stringify(record.filePaths ?? []),
    JSON.stringify(record.commands ?? []), record.workspaceTag ?? null, record.projectTag ?? null,
    record.orgId ?? null, record.visibility ?? "private",
  ];
}

export async function upsertCognitiveMeta(client: PoolClient, record: CognitiveRecord): Promise<void> {
  await client.query(
    `INSERT INTO cognitive_records (
       record_id, user_id, session_key, session_id, content, type, priority, scene_name, skill_tag,
       half_life_days, superseded_by, invalid_at, timestamp_str, timestamp_start, timestamp_end,
       created_time, updated_time, metadata_json, confidence, status, source_kind, verification_status,
       repo_paths_json, file_paths_json, commands_json, workspace_tag, project_tag, org_id, visibility
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
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
       project_tag=COALESCE(EXCLUDED.project_tag, cognitive_records.project_tag),
       org_id=COALESCE(EXCLUDED.org_id, cognitive_records.org_id),
       visibility=EXCLUDED.visibility`,
    cognitiveUpsertParams(record),
  );
}

export async function replaceFileIndexTx(client: PoolClient, record: CognitiveRecord): Promise<void> {
  await client.query("DELETE FROM memory_file_index WHERE user_id = $1 AND record_id = $2", [record.userId, record.id]);
  const filePaths = [...new Set((record.filePaths ?? []).map((fp) => fp.trim()).filter(Boolean))];
  for (const filePath of filePaths) {
    await client.query(
      "INSERT INTO memory_file_index (id, user_id, record_id, file_path, symbol, created_time) VALUES ($1,$2,$3,$4,'',$5)",
      [randomUUID(), record.userId, record.id, filePath, record.createdTime],
    );
  }
}

export async function insertOperationTx(client: PoolClient, op: MemoryOperation): Promise<void> {
  await client.query(
    `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       operation=EXCLUDED.operation, actor=EXCLUDED.actor, session_key=EXCLUDED.session_key,
       reason=EXCLUDED.reason, metadata_json=EXCLUDED.metadata_json`,
    [op.id, op.userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
  );
}

export async function upsertCognitiveBatch(
  exec: Executor,
  vecReady: boolean,
  entries: Array<{ record: CognitiveRecord; embedding?: Float32Array }>,
  options?: { skipAudit?: boolean },
): Promise<void> {
  await exec.tx(async (client) => {
    for (const entry of entries) {
      const record = entry.record;
      await upsertCognitiveMeta(client, record);
      // FTS column is generated — no FTS insert needed.
      if (entry.embedding && vecReady) {
        await client.query(
          `INSERT INTO cognitive_vec (record_id, embedding) VALUES ($1, $2::vector)
           ON CONFLICT (record_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [record.id, toVectorLiteral(entry.embedding)],
        );
      }
      await replaceFileIndexTx(client, record);
      if (!options?.skipAudit) {
        await insertOperationTx(client, {
          id: randomUUID(), userId: record.userId, recordId: record.id,
          operation: "cognitive_upsert", actor: "system", sessionKey: record.sessionKey,
          reason: "", createdAt: new Date().toISOString(), metadata: { batch: true, type: record.type },
        });
      }
    }
  });
}

export async function upsertCognitive(exec: Executor, record: CognitiveRecord, options?: { skipAudit?: boolean }): Promise<void> {
  await exec.tx(async (client) => {
    await upsertCognitiveMeta(client, record);
    await replaceFileIndexTx(client, record);
    if (!options?.skipAudit) {
      await insertOperationTx(client, {
        id: randomUUID(), userId: record.userId, recordId: record.id,
        operation: "cognitive_upsert", actor: "system", sessionKey: record.sessionKey,
        reason: "", createdAt: new Date().toISOString(), metadata: { type: record.type },
      });
    }
  });
}

export async function invalidateCognitiveRecord(exec: Executor, userId: string, recordId: string, supersededById: string): Promise<void> {
  const now = new Date().toISOString();
  await exec.run(
    "UPDATE cognitive_records SET invalid_at = $1, superseded_by = $2, status = 'superseded' WHERE user_id = $3 AND record_id = $4",
    [now, supersededById, userId, recordId],
  );
  await insertOperation(exec, {
    id: randomUUID(), userId, recordId, operation: "cognitive_supersede", actor: "system",
    sessionKey: "", reason: `Superseded by ${supersededById}`, createdAt: now, metadata: { supersededById },
  });
}

export async function getMemoryById(exec: Executor, userId: string, recordId: string): Promise<CognitiveRecord | null> {
  const row = await exec.one("SELECT * FROM cognitive_records WHERE record_id = $1 AND user_id = $2", [recordId, userId]);
  return row ? cognitiveRowToRecord(row) : null;
}

export async function getMemoriesByFilePath(exec: Executor, userId: string, filePath: string, limit: number): Promise<CognitiveRecord[]> {
  const rows = await exec.rows(
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

export async function findLessonByFingerprint(exec: Executor, userId: string, fingerprint: string): Promise<CognitiveRecord | null> {
  const row = await exec.one(
    `SELECT r.* FROM cognitive_records r
      WHERE r.user_id = $1 AND r.type = 'lesson'
        AND r.metadata_json::jsonb ->> 'fingerprint' = $2
        AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY r.created_time DESC LIMIT 1`,
    [userId, fingerprint],
  );
  return row ? cognitiveRowToRecord(row) : null;
}

export async function findLessonsByConflictKey(exec: Executor, userId: string, conflictKey: string): Promise<CognitiveRecord[]> {
  const rows = await exec.rows(
    `SELECT r.* FROM cognitive_records r
      WHERE r.user_id = $1 AND r.type = 'lesson'
        AND r.metadata_json::jsonb ->> 'conflictKey' = $2
        AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY r.created_time DESC LIMIT 50`,
    [userId, conflictKey],
  );
  return rows.map(cognitiveRowToRecord);
}

export async function listLessonsForHygiene(exec: Executor, userId: string, limit: number): Promise<CognitiveRecord[]> {
  const rows = await exec.rows(
    `SELECT r.* FROM cognitive_records r
      WHERE r.user_id = $1 AND r.type = 'lesson'
        AND r.invalid_at IS NULL AND r.archived = 0
      ORDER BY r.created_time ASC LIMIT $2`,
    [userId, Math.max(1, limit)],
  );
  return rows.map(cognitiveRowToRecord);
}

export async function updateCognitiveConfidence(exec: Executor, userId: string, recordId: string, confidence: number, status: MemoryStatus): Promise<void> {
  const now = new Date().toISOString();
  await exec.run(
    "UPDATE cognitive_records SET confidence = $1, status = $2, archived = CASE WHEN $3 = 'archived' THEN 1 ELSE archived END, updated_time = $4 WHERE user_id = $5 AND record_id = $6",
    [confidence, status, status, now, userId, recordId],
  );
  await insertOperation(exec, {
    id: randomUUID(), userId, recordId, operation: "cognitive_status_update", actor: "system",
    sessionKey: "", reason: "", createdAt: now, metadata: { confidence, status },
  });
}

// ── ACE feedback loop ──────────────────────────────────────────────────

export async function markCited(exec: Executor, userId: string, recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return;
  const now = new Date().toISOString();
  await exec.run(
    `UPDATE cognitive_records SET citation_count = citation_count + 1, last_cited_at = $1, never_cited_count = 0, updated_time = $2
      WHERE user_id = $3 AND record_id = ANY($4::text[])`,
    [now, now, userId, recordIds],
  );
}

export async function incrementNeverCited(exec: Executor, userId: string, recordIds: string[]): Promise<{ recordId: string; neverCitedCount: number }[]> {
  if (recordIds.length === 0) return [];
  const now = new Date().toISOString();
  await exec.run(
    "UPDATE cognitive_records SET never_cited_count = never_cited_count + 1, updated_time = $1 WHERE user_id = $2 AND record_id = ANY($3::text[])",
    [now, userId, recordIds],
  );
  const rows = await exec.rows<any>(
    "SELECT record_id, never_cited_count FROM cognitive_records WHERE user_id = $1 AND record_id = ANY($2::text[])",
    [userId, recordIds],
  );
  return rows.map((r) => ({ recordId: r.record_id, neverCitedCount: asNumber(r.never_cited_count) }));
}

export async function archiveCognitiveRecord(exec: Executor, userId: string, recordId: string): Promise<void> {
  const now = new Date().toISOString();
  await exec.run("UPDATE cognitive_records SET archived = 1, status = 'archived', updated_time = $1 WHERE user_id = $2 AND record_id = $3", [now, userId, recordId]);
  await insertOperation(exec, {
    id: randomUUID(), userId, recordId, operation: "archive", actor: "system",
    sessionKey: "", reason: "", createdAt: now, metadata: {},
  });
}

export async function getRecentSkillContextCognitives(exec: Executor, userId: string, limit: number): Promise<{ skillTag: string; createdTime: string }[]> {
  const rows = await exec.rows<any>(
    `SELECT skill_tag, created_time FROM cognitive_records
      WHERE user_id = $1 AND type = 'skill_context' AND skill_tag != '' AND invalid_at IS NULL AND archived = 0
      ORDER BY created_time DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ skillTag: r.skill_tag, createdTime: r.created_time }));
}
