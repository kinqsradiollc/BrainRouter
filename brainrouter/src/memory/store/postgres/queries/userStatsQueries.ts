/**
 * Users, memory list/stats, and dendritic-connection SQL — verbatim extraction
 * from `PostgresMemoryStore`. `getMemoryStats` still composes the focus-count
 * and extraction-status helpers (imported from their domain modules).
 */

import type {
  CursorPaginationOptions,
  ExtractionStatus,
  MemoryListFilters,
  MemoryListItem,
  UserRecord,
} from "@kinqs/brainrouter-types";
import { asNumber, pg } from "../converters.js";
import type { Executor } from "./executor.js";
import { getContextualFocusCount } from "./skillFocusQueries.js";
import { getExtractionStatus } from "./atlasIdentityQueries.js";

// ── users ──────────────────────────────────────────────────────────────

function userRow(row: any): UserRecord {
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

export async function createUser(exec: Executor, userId: string, apiKey: string, displayName = "", isAdmin = false): Promise<UserRecord> {
  const createdAt = new Date().toISOString();
  await exec.run(
    `INSERT INTO users (user_id, api_key, password_hash, display_name, email, is_admin, status, created_at)
     VALUES ($1,$2,NULL,$3,'',$4,'active',$5)`,
    [userId, apiKey, displayName, isAdmin ? 1 : 0, createdAt],
  );
  return { userId, apiKey, passwordHash: null, displayName, email: "", isAdmin, status: "active", createdAt };
}

export async function getUserByApiKey(exec: Executor, apiKey: string): Promise<UserRecord | null> {
  const row = await exec.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE api_key = $1", [apiKey]);
  return row ? userRow(row) : null;
}

export async function getUserByEmail(exec: Executor, email: string): Promise<UserRecord | null> {
  const row = await exec.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE lower(email) = lower($1)", [email]);
  return row ? userRow(row) : null;
}

export async function getUserById(exec: Executor, userId: string): Promise<UserRecord | null> {
  const row = await exec.one("SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at FROM users WHERE user_id = $1", [userId]);
  return row ? userRow(row) : null;
}

export async function updateUserPassword(exec: Executor, userId: string, passwordHash: string): Promise<void> {
  await exec.run("UPDATE users SET password_hash = $1 WHERE user_id = $2", [passwordHash, userId]);
}
export async function updateUserEmail(exec: Executor, userId: string, email: string): Promise<void> {
  await exec.run("UPDATE users SET email = $1 WHERE user_id = $2", [email, userId]);
}
export async function updateUserDisplayName(exec: Executor, userId: string, displayName: string): Promise<void> {
  await exec.run("UPDATE users SET display_name = $1 WHERE user_id = $2", [displayName, userId]);
}
export async function updateUserStatus(exec: Executor, userId: string, status: "active" | "disabled"): Promise<void> {
  await exec.run("UPDATE users SET status = $1 WHERE user_id = $2", [status, userId]);
}
export async function updateUserApiKey(exec: Executor, userId: string, apiKey: string): Promise<void> {
  await exec.run("UPDATE users SET api_key = $1 WHERE user_id = $2", [apiKey, userId]);
}

export async function listUsers(exec: Executor, pagination?: CursorPaginationOptions<{ createdAt: string; userId: string }>): Promise<UserRecord[]> {
  const where: string[] = [];
  const args: any[] = [];
  if (pagination?.cursor) {
    where.push("(created_at < ? OR (created_at = ? AND user_id > ?))");
    args.push(pagination.cursor.createdAt, pagination.cursor.createdAt, pagination.cursor.userId);
  }
  args.push(pagination?.limit ?? 500);
  const rows = await exec.rows(
    pg(`SELECT user_id, api_key, password_hash, display_name, email, is_admin, status, created_at
          FROM users ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, user_id ASC LIMIT ?`),
    args,
  );
  return rows.map((row) => userRow(row));
}

export async function deleteUser(exec: Executor, userId: string): Promise<void> {
  await exec.tx(async (client) => {
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

export async function listMemories(
  exec: Executor,
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
  const rows = await exec.rows<any>(
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

export async function getMemoryStats(exec: Executor, userId: string): Promise<{
  total: number; archived: number; byType: Record<string, number>; citationRate: number;
  lastRecallAt: string | null; sensoryTotal: number; sensoryUnextracted: number;
  focusSceneTotal: number; extraction: ExtractionStatus;
}> {
  const totalRow = await exec.one<{ c: string }>("SELECT COUNT(*) AS c FROM cognitive_records WHERE user_id = $1", [userId]);
  const archivedRow = await exec.one<{ c: string }>("SELECT COUNT(*) AS c FROM cognitive_records WHERE user_id = $1 AND archived = 1", [userId]);
  const typeRows = await exec.rows<{ type: string; c: string }>("SELECT type, COUNT(*) AS c FROM cognitive_records WHERE user_id = $1 GROUP BY type", [userId]);
  const citationRows = await exec.one<{ cited: string | null; total: string }>("SELECT SUM(citation_count) AS cited, COUNT(*) AS total FROM cognitive_records WHERE user_id = $1", [userId]);
  const sensoryTotalRow = await exec.one<{ c: string; last_at: string | null }>("SELECT COUNT(*) AS c, MAX(recorded_at) AS last_at FROM sensory_stream WHERE user_id = $1", [userId]);
  const sensoryUnextractedRow = await exec.one<{ c: string }>("SELECT COUNT(*) AS c FROM sensory_stream WHERE user_id = $1 AND extracted_at IS NULL", [userId]);

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
    focusSceneTotal: await getContextualFocusCount(exec, userId),
    extraction: await getExtractionStatus(exec, userId),
  };
}

// ── dendritic connections ───────────────────────────────────────────────

export async function upsertConnection(exec: Executor, userId: string, sourceId: string, targetId: string, weight: number): Promise<void> {
  await exec.run(
    `INSERT INTO cognitive_connections (user_id, source_id, target_id, weight, last_activated_at)
     VALUES ($1,$2,$3,$4, now()::text)
     ON CONFLICT (user_id, source_id, target_id) DO UPDATE SET weight = EXCLUDED.weight, last_activated_at = now()::text`,
    [userId, sourceId, targetId, weight],
  );
}

export async function getConnectionsForSource(exec: Executor, userId: string, sourceId: string): Promise<Array<{ targetId: string; weight: number }>> {
  const rows = await exec.rows<any>(
    "SELECT target_id, weight FROM cognitive_connections WHERE user_id = $1 AND source_id = $2 AND weight >= 0.1",
    [userId, sourceId],
  );
  return rows.map((r) => ({ targetId: r.target_id, weight: asNumber(r.weight) }));
}

export async function strengthenConnectionsBatch(exec: Executor, userId: string, pairs: Array<{ source: string; target: string }>, delta: number): Promise<void> {
  if (pairs.length === 0) return;
  await exec.tx(async (client) => {
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

export async function decayConnections(exec: Executor, userId: string, decayFactor: number): Promise<void> {
  await exec.run("UPDATE cognitive_connections SET weight = GREATEST(0.0, weight * $1) WHERE user_id = $2", [decayFactor, userId]);
}

export async function pruneConnections(exec: Executor, userId: string, threshold: number): Promise<void> {
  await exec.run("DELETE FROM cognitive_connections WHERE user_id = $1 AND weight < $2", [userId, threshold]);
}

export async function getAllConnections(exec: Executor, userId: string): Promise<Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }>> {
  const rows = await exec.rows<any>("SELECT source_id, target_id, weight, last_activated_at FROM cognitive_connections WHERE user_id = $1", [userId]);
  return rows.map((r) => ({ sourceId: r.source_id, targetId: r.target_id, weight: asNumber(r.weight), lastActivatedAt: r.last_activated_at ?? "" }));
}
