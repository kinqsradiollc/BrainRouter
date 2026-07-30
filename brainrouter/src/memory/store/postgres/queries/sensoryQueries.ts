/**
 * Sensory-stream SQL — verbatim extraction from `PostgresMemoryStore`.
 */

import type { SensoryRecord } from "@kinqs/brainrouter-types";
import { asNumber, parseJsonArray } from "../converters.js";
import type { Executor } from "./executor.js";

export async function upsertSensory(exec: Executor, record: SensoryRecord): Promise<void> {
  await exec.run(
    `INSERT INTO sensory_stream (record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag, memory_tags_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (record_id) DO UPDATE SET
       message_text = EXCLUDED.message_text,
       recorded_at = EXCLUDED.recorded_at,
       timestamp = EXCLUDED.timestamp,
       memory_tags_json = EXCLUDED.memory_tags_json`,
    [record.id, record.userId, record.sessionKey, record.sessionId, record.role, record.messageText, record.recordedAt, record.timestamp, record.skillTag, JSON.stringify(record.memoryTags ?? [])],
  );
}

export async function getRecentSensoryMessages(exec: Executor, userId: string, sessionKey: string, limit: number, afterIsoTime = ""): Promise<SensoryRecord[]> {
  const rows = await exec.rows<any>(
    `SELECT record_id, user_id, session_key, session_id, role, message_text, recorded_at, timestamp, skill_tag, memory_tags_json
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
    memoryTags: parseJsonArray(r.memory_tags_json),
  }));
}

export async function getUnextractedSensoryCount(exec: Executor, userId: string, sessionKey: string): Promise<number> {
  const row = await exec.one<{ count: string }>(
    "SELECT COUNT(*) AS count FROM sensory_stream WHERE user_id = $1 AND session_key = $2 AND extracted_at IS NULL",
    [userId, sessionKey],
  );
  return asNumber(row?.count);
}

export async function markSensoryExtracted(exec: Executor, userId: string, sessionKey: string, recordIds: string[], extractedAt = new Date().toISOString()): Promise<void> {
  if (recordIds.length === 0) return;
  await exec.run(
    "UPDATE sensory_stream SET extracted_at = $1 WHERE user_id = $2 AND session_key = $3 AND record_id = ANY($4::text[])",
    [extractedAt, userId, sessionKey, recordIds],
  );
}
