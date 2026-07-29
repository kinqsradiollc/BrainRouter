/**
 * Federation SQL: active sessions, session inbox, and pending delegations —
 * verbatim extraction from `PostgresMemoryStore`.
 */

import { randomUUID } from "node:crypto";
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
  StoredDelegationPacket,
} from "@kinqs/brainrouter-types";
import {
  activeSessionRowToRecord,
  inboxRowToRecord,
  pg,
} from "../converters.js";
import type { Executor } from "./executor.js";

// ── active sessions (federation) ─────────────────────────────────────────

export async function registerActiveSession(exec: Executor, record: ActiveSessionRecord): Promise<ActiveSessionRecord> {
  await exec.run(
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
  return (await getActiveSession(exec, record.userId, record.sessionKey))!;
}

export async function heartbeatActiveSession(exec: Executor, userId: string, sessionKey: string, at: string, usage?: ActiveSessionUsage | null): Promise<boolean> {
  const changed = await exec.run(
    `UPDATE active_sessions SET last_heartbeat_at = $1, usage_json = COALESCE($2, usage_json) WHERE session_key = $3 AND user_id = $4`,
    [at, usage ? JSON.stringify(usage) : null, sessionKey, userId],
  );
  return changed > 0;
}

export async function listActiveSessions(exec: Executor, filters: ActiveSessionFilters): Promise<ActiveSessionRecord[]> {
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
  const rows = await exec.rows<any>(
    pg(`SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
          FROM active_sessions ${whereSql}
         ORDER BY last_heartbeat_at DESC, session_key ASC`),
    params,
  );
  return rows.map((row) => activeSessionRowToRecord(row, filters.includeUsage ?? false));
}

export async function unregisterActiveSession(exec: Executor, userId: string, sessionKey: string): Promise<boolean> {
  const changed = await exec.run("DELETE FROM active_sessions WHERE session_key = $1 AND user_id = $2", [sessionKey, userId]);
  return changed > 0;
}

export async function sweepActiveSessions(exec: Executor, olderThanMs: number): Promise<number> {
  return exec.run("DELETE FROM active_sessions WHERE last_heartbeat_at < $1", [new Date(Date.now() - olderThanMs).toISOString()]);
}

async function getActiveSession(exec: Executor, userId: string, sessionKey: string): Promise<ActiveSessionRecord | null> {
  const row = await exec.one<any>(
    `SELECT session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
       FROM active_sessions WHERE session_key = $1 AND user_id = $2`,
    [sessionKey, userId],
  );
  return row ? activeSessionRowToRecord(row, true) : null;
}

// ── session inbox (federation) ───────────────────────────────────────────

export async function sendSessionMessage(
  exec: Executor,
  record: Omit<SessionInboxRecord, "id" | "createdAt" | "deliveredAt">,
  options?: { idGenerator?: () => string; now?: string },
): Promise<SessionInboxRecord[]> {
  const now = options?.now ?? new Date().toISOString();
  const idFor = options?.idGenerator ?? (() => randomUUID());
  const recipients = await resolveInboxRecipients(exec, record.userId, record.toSessionKey);
  if (recipients.length === 0) return [];
  const rows: SessionInboxRecord[] = [];
  await exec.tx(async (client) => {
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

async function resolveInboxRecipients(exec: Executor, userId: string, address: string): Promise<string[]> {
  if (!address) return [];
  if (address === "*" || address.toLowerCase() === "broadcast") {
    return activeSessionKeysForUser(exec, userId);
  }
  const wildcardMatch = /^([^:]+):\*$/.exec(address);
  if (wildcardMatch) {
    return activeSessionKeysForUser(exec, userId, wildcardMatch[1]);
  }
  return [address];
}

async function activeSessionKeysForUser(exec: Executor, userId: string, clientKindFilter?: string): Promise<string[]> {
  const activeCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const rows = clientKindFilter
    ? await exec.rows<{ session_key: string }>(
        "SELECT session_key FROM active_sessions WHERE user_id = $1 AND client_kind = $2 AND last_heartbeat_at >= $3",
        [userId, clientKindFilter, activeCutoff],
      )
    : await exec.rows<{ session_key: string }>(
        "SELECT session_key FROM active_sessions WHERE user_id = $1 AND last_heartbeat_at >= $2",
        [userId, activeCutoff],
      );
  return rows.map((r) => r.session_key);
}

export async function readSessionInbox(exec: Executor, filters: SessionInboxFilters): Promise<SessionInboxRecord[]> {
  const limit = filters.limit ?? 50;
  const includeDelivered = filters.includeDelivered ?? false;
  const where: string[] = ["user_id = ?", "to_session_key = ?"];
  const params: any[] = [filters.userId, filters.toSessionKey];
  if (!includeDelivered) where.push("delivered_at IS NULL");
  params.push(limit);
  const rows = await exec.rows<any>(
    pg(`SELECT id, user_id, from_session_key, to_session_key, kind, payload_json, created_at, delivered_at
          FROM session_inbox WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC, id ASC LIMIT ?`),
    params,
  );
  return rows.map(inboxRowToRecord);
}

export async function ackSessionInbox(exec: Executor, userId: string, toSessionKey: string, ids: string[], at: string): Promise<number> {
  if (ids.length === 0) return 0;
  const capped = ids.slice(0, 500);
  return exec.run(
    `UPDATE session_inbox SET delivered_at = $1
      WHERE user_id = $2 AND to_session_key = $3 AND delivered_at IS NULL AND id = ANY($4::text[])`,
    [at, userId, toSessionKey, capped],
  );
}

export async function sweepSessionInbox(exec: Executor, olderThanMs: number): Promise<number> {
  return exec.run(
    "DELETE FROM session_inbox WHERE delivered_at IS NOT NULL AND delivered_at < $1",
    [new Date(Date.now() - olderThanMs).toISOString()],
  );
}

// ── pending delegations (federation) ─────────────────────────────────────

function rowToPendingDelegation(row: any): PendingDelegationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fromSessionKey: row.from_session_key,
    toAgentKind: row.to_agent_kind,
    toSessionKey: row.to_session_key ?? null,
    packet: (typeof row.packet_json === "string" ? JSON.parse(row.packet_json || "{}") : (row.packet_json ?? {})) as StoredDelegationPacket,
    status: row.status as PendingDelegationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at ?? null,
  };
}

export async function enqueuePendingDelegation(exec: Executor, input: PendingDelegationEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<PendingDelegationRecord> {
  const now = options?.now ?? new Date().toISOString();
  const id = (options?.idGenerator ?? (() => randomUUID()))();
  await exec.run(
    `INSERT INTO pending_delegations (id, user_id, from_session_key, to_agent_kind, to_session_key, packet_json, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,NULL,$5,'pending',$6,$7)`,
    [id, input.userId, input.fromSessionKey, input.toAgentKind, JSON.stringify(input.packet ?? {}), now, now],
  );
  return {
    id, userId: input.userId, fromSessionKey: input.fromSessionKey, toAgentKind: input.toAgentKind,
    toSessionKey: null, packet: input.packet, status: "pending", createdAt: now, updatedAt: now, claimedAt: null,
  };
}

export async function listPendingDelegations(exec: Executor, filters: PendingDelegationFilters): Promise<PendingDelegationRecord[]> {
  const clauses = ["user_id = ?"];
  const params: any[] = [filters.userId];
  if (filters.toAgentKind) { clauses.push("to_agent_kind = ?"); params.push(filters.toAgentKind); }
  if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  params.push(limit);
  const rows = await exec.rows<any>(
    pg(`SELECT * FROM pending_delegations WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`),
    params,
  );
  return rows.map((r) => rowToPendingDelegation(r));
}

export async function claimPendingDelegation(exec: Executor, userId: string, toAgentKind: string, toSessionKey: string, at: string): Promise<PendingDelegationRecord | null> {
  // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED so concurrent claimers get
  // distinct rows (the pg analogue of the SQLite single-writer SELECT→UPDATE).
  return exec.tx(async (client) => {
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
    return rowToPendingDelegation({ ...row, status: "claimed", to_session_key: toSessionKey, claimed_at: at, updated_at: at });
  });
}
