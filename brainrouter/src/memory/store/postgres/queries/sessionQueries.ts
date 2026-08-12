/**
 * Federation SQL: active sessions, session inbox, and pending delegations —
 * verbatim extraction from `PostgresMemoryStore`.
 */

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  ActiveSessionClaim,
  ActiveSessionFilters,
  ActiveSessionRecord,
  ActiveSessionUsage,
  LegacySessionMessageSendInput,
  LegacySessionMessageSendOptions,
  SessionInboxFilters,
  SessionInboxRecord,
  SessionMessageReceiptAckInput,
  SessionMessageReceiptFilters,
  SessionMessageRejectionReason,
  SessionMessageRouteOptions,
  SessionMessageSendInput,
  SessionMessageSendResult,
  SessionMessageSendState,
  SessionMessageStatus,
  SessionMessageStoreNotification,
  SessionMessageTransitionInput,
  PendingDelegationRecord,
  PendingDelegationEnqueueInput,
  PendingDelegationFilters,
  PendingDelegationStatus,
  StoredDelegationPacket,
} from "@kinqs/brainrouter-types";
import {
  ACTIVE_SESSION_CLAIM_LEASE_MS,
  SESSION_MESSAGE_MAX_FANOUT,
  SESSION_MESSAGE_MAX_PENDING_PER_RECIPIENT,
  SESSION_MESSAGE_NOTIFICATION_CHANNEL,
  SESSION_MESSAGE_PENDING_TTL_MS,
  SESSION_MESSAGE_TERMINAL_RETENTION_MS,
} from "@kinqs/brainrouter-types";
import {
  activeSessionRowToRecord,
  inboxRowToRecord,
  pg,
} from "../converters.js";
import type { Executor } from "./executor.js";

// ── active sessions (federation) ─────────────────────────────────────────

const ACTIVE_SESSION_STALE_MS = ACTIVE_SESSION_CLAIM_LEASE_MS;

function dbOrgId(orgId: string | null | undefined): string {
  return orgId ?? "";
}

function effectiveActiveSessionClaim(
  claim: ActiveSessionClaim | undefined,
): ActiveSessionClaim {
  const effective = claim ?? { token: `trusted:${randomUUID()}` };
  if (!effective.token) throw new Error("active session claim token must not be empty");
  return effective;
}

export async function registerActiveSession(
  exec: Executor,
  record: ActiveSessionRecord,
  claim?: ActiveSessionClaim,
): Promise<ActiveSessionRecord> {
  const effectiveClaim = effectiveActiveSessionClaim(claim);
  const row = await exec.one<any>(
    `INSERT INTO active_sessions (
       org_id, session_key, user_id, client_kind, workspace_root, started_at,
       last_heartbeat_at, metadata_json, usage_json, claim_token, claim_expires_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,
       CASE WHEN $12::boolean THEN
         to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ELSE $7 END,
       $8,$9,$10,
       (CURRENT_TIMESTAMP + ($11 * interval '1 millisecond'))::text)
     ON CONFLICT (org_id, user_id, session_key) DO UPDATE SET
       client_kind = EXCLUDED.client_kind,
       workspace_root = EXCLUDED.workspace_root,
       last_heartbeat_at = CASE
         WHEN $12::boolean THEN
           to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ELSE EXCLUDED.last_heartbeat_at
       END,
       metadata_json = EXCLUDED.metadata_json,
       usage_json = COALESCE(EXCLUDED.usage_json, active_sessions.usage_json),
       claim_token = EXCLUDED.claim_token,
       claim_expires_at = EXCLUDED.claim_expires_at
     WHERE NOT $12::boolean
        OR active_sessions.claim_token = EXCLUDED.claim_token
        OR active_sessions.claim_expires_at::timestamptz <= CURRENT_TIMESTAMP
     RETURNING org_id, session_key, user_id, client_kind, workspace_root,
       started_at, last_heartbeat_at, metadata_json, usage_json`,
    [
      dbOrgId(record.orgId), record.sessionKey, record.userId, record.clientKind,
      record.workspaceRoot, record.startedAt, record.lastHeartbeatAt,
      JSON.stringify(record.metadata ?? {}), record.usage ? JSON.stringify(record.usage) : null,
      effectiveClaim.token, ACTIVE_SESSION_CLAIM_LEASE_MS, claim !== undefined,
    ],
  );
  if (!row) {
    const error = new Error("this live session key is already claimed by another MCP connection") as Error & { code?: string };
    error.code = "ACTIVE_SESSION_CLAIM_CONFLICT";
    throw error;
  }
  return activeSessionRowToRecord(row, true);
}

export async function heartbeatActiveSession(
  exec: Executor,
  userId: string,
  sessionKey: string,
  at: string,
  usage?: ActiveSessionUsage | null,
  orgId?: string | null,
  claim?: ActiveSessionClaim,
): Promise<boolean> {
  if (claim && !claim.token) throw new Error("active session claim token must not be empty");
  const changed = await exec.run(
    `UPDATE active_sessions
        SET last_heartbeat_at = CASE
              WHEN $7::boolean THEN
                to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ELSE $1
            END,
            usage_json = COALESCE($2, usage_json),
            claim_expires_at = (CURRENT_TIMESTAMP + ($3 * interval '1 millisecond'))::text
      WHERE org_id = $4 AND user_id = $5 AND session_key = $6
        AND (NOT $7::boolean OR (
          claim_token = $8 AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP
        ))`,
    [
      at, usage ? JSON.stringify(usage) : null, ACTIVE_SESSION_CLAIM_LEASE_MS,
      dbOrgId(orgId), userId, sessionKey, claim !== undefined, claim?.token ?? "",
    ],
  );
  return changed > 0;
}

export async function ownsActiveSessionClaim(
  exec: Executor,
  orgId: string | null,
  userId: string,
  sessionKey: string,
  claimToken: string,
): Promise<boolean> {
  if (!claimToken) return false;
  const row = await exec.one<{ owned: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM active_sessions
        WHERE org_id = $1 AND user_id = $2 AND session_key = $3
          AND claim_token = $4
          AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP
     ) AS owned`,
    [dbOrgId(orgId), userId, sessionKey, claimToken],
  );
  return row?.owned === true;
}

export async function listActiveSessions(exec: Executor, filters: ActiveSessionFilters): Promise<ActiveSessionRecord[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (!filters.includeAllTenants) { where.push("org_id = ?"); params.push(dbOrgId(filters.orgId)); }
  if (filters.userId) { where.push("user_id = ?"); params.push(filters.userId); }
  if (filters.clientKind) { where.push("client_kind = ?"); params.push(filters.clientKind); }
  if (filters.workspaceRoot) { where.push("workspace_root = ?"); params.push(filters.workspaceRoot); }
  if (!filters.includeStale) {
    const threshold = filters.staleThresholdMs ?? ACTIVE_SESSION_STALE_MS;
    where.push("last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - (? * interval '1 millisecond')");
    params.push(threshold);
    where.push("claim_expires_at::timestamptz > CURRENT_TIMESTAMP");
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await exec.rows<any>(
    pg(`SELECT org_id, session_key, user_id, client_kind, workspace_root, started_at, last_heartbeat_at, metadata_json, usage_json
          FROM active_sessions ${whereSql}
         ORDER BY last_heartbeat_at DESC, session_key ASC`),
    params,
  );
  return rows.map((row) => activeSessionRowToRecord(row, filters.includeUsage ?? false));
}

export async function unregisterActiveSession(
  exec: Executor,
  userId: string,
  sessionKey: string,
  orgId?: string | null,
  claimToken?: string,
): Promise<boolean> {
  const changed = await exec.run(
    `DELETE FROM active_sessions
      WHERE org_id = $1 AND user_id = $2 AND session_key = $3
        AND (NOT $4::boolean OR claim_token = $5)`,
    [dbOrgId(orgId), userId, sessionKey, claimToken !== undefined, claimToken ?? ""],
  );
  return changed > 0;
}

export async function releaseActiveSessionClaims(exec: Executor, claimToken: string): Promise<number> {
  if (!claimToken) return 0;
  return exec.run("DELETE FROM active_sessions WHERE claim_token = $1", [claimToken]);
}

export async function sweepActiveSessions(exec: Executor, olderThanMs: number): Promise<number> {
  return exec.run(
    `DELETE FROM active_sessions
      WHERE last_heartbeat_at < $1
        AND (
          claim_token LIKE 'trusted:%'
          OR claim_expires_at::timestamptz <= CURRENT_TIMESTAMP
        )`,
    [new Date(Date.now() - olderThanMs).toISOString()],
  );
}

// ── session inbox (federation) ───────────────────────────────────────────

const INBOX_COLUMNS = `id, org_id, user_id, message_id, from_session_key,
  to_session_key, kind, payload_json, status, status_reason, created_at,
  updated_at, expires_at, terminal_at, sender_acknowledged_at, delivered_at`;
const TERMINAL_MESSAGE_STATUSES = new Set<SessionMessageStatus>([
  "applied", "rejected", "declined", "expired", "queue_full",
]);
const REJECTED_MESSAGE_STATUSES = new Set<SessionMessageStatus>(["rejected", "queue_full"]);
const ROUTE_REJECTION_REASONS = new Set<SessionMessageRejectionReason>([
  "sender_not_active",
  "recipient_not_active",
  "no_active_recipient",
  "self_send",
  "fanout_limit_exceeded",
  "queue_full",
]);
const SENDER_PROVENANCE_PAYLOAD_KEYS = new Set([
  "senderDeviceId",
  "senderClientKind",
  "senderTitle",
  "senderWorkspaceRoot",
]);
const MAX_ID_LENGTH = 512;
const MAX_PAYLOAD_BYTES = 64 * 1024;

interface ActiveRouteRow {
  session_key: string;
  client_kind: string;
  workspace_root: string;
  metadata_json: string | Record<string, unknown> | null;
  claim_token: string;
}

function assertRouteText(label: string, value: string): void {
  if (!value || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must contain 1-${MAX_ID_LENGTH} characters`);
  }
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

function payloadForRoute(payload: Record<string, unknown>): { json: string; hash: string } {
  const json = JSON.stringify(sortedJson(payload ?? {}));
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`session message payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return { json, hash: createHash("sha256").update(json).digest("hex") };
}

function senderContentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !SENDER_PROVENANCE_PAYLOAD_KEYS.has(key)),
  );
}

function activeSessionMetadata(row: ActiveRouteRow): Record<string, unknown> {
  if (row.metadata_json && typeof row.metadata_json === "object") return row.metadata_json;
  if (typeof row.metadata_json !== "string") return {};
  try {
    const parsed = JSON.parse(row.metadata_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Replace reserved identity fields with metadata pinned to the active sender row. */
function payloadWithAuthenticatedSender(
  payload: Record<string, unknown>,
  sender: ActiveRouteRow,
): Record<string, unknown> {
  const metadata = activeSessionMetadata(sender);
  const deviceId = typeof metadata.deviceId === "string" ? metadata.deviceId.trim() : "";
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const clientKind = String(sender.client_kind ?? "http-unknown").trim() || "http-unknown";
  const workspaceRoot = String(sender.workspace_root ?? "").trim();
  return {
    ...payload,
    ...(deviceId ? { senderDeviceId: deviceId.slice(0, 64) } : {}),
    senderClientKind: clientKind.slice(0, 120),
    ...(title ? { senderTitle: title.slice(0, 60) } : {}),
    ...(workspaceRoot ? { senderWorkspaceRoot: workspaceRoot.slice(0, 4096) } : {}),
  };
}

function routeRejectionReason(value: unknown): SessionMessageRejectionReason | undefined {
  return typeof value === "string" && ROUTE_REJECTION_REASONS.has(value as SessionMessageRejectionReason)
    ? value as SessionMessageRejectionReason
    : undefined;
}

function aggregateSendState(
  receipts: readonly SessionInboxRecord[],
  rejectionReason: SessionMessageRejectionReason | undefined,
): SessionMessageSendState {
  if (receipts.length === 0) return rejectionReason ? "not-queued" : "mixed";
  const states = new Set(receipts.map((row) => row.status ?? "pending"));
  if ([...states].every((status) => REJECTED_MESSAGE_STATUSES.has(status))) return "not-queued";
  if (states.size !== 1) return "mixed";
  const status = states.values().next().value as SessionMessageStatus;
  if (status === "pending") return "persisted-unseen";
  if (status === "held" || status === "applied" || status === "declined" || status === "expired") {
    return status;
  }
  return "not-queued";
}

function routeNow(value?: string): { iso: string; ms: number } {
  const ms = value === undefined ? Date.now() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("session message timestamp must be ISO-8601");
  return { iso: new Date(ms).toISOString(), ms };
}

function sendResult(
  messageId: string,
  receipts: SessionInboxRecord[],
  idempotentReplay: boolean,
  rejectionReason?: SessionMessageRejectionReason,
): SessionMessageSendResult {
  const deliveries = receipts.filter((row) => row.status === "pending");
  const rejected = receipts.filter((row) => REJECTED_MESSAGE_STATUSES.has(row.status ?? "pending")).length;
  const effectiveReason = rejectionReason ?? (
    receipts.length > 0 && receipts.every((row) => row.status === "queue_full")
      ? "queue_full"
      : receipts.length > 0 && receipts.every((row) => REJECTED_MESSAGE_STATUSES.has(row.status ?? "pending"))
        ? routeRejectionReason(receipts[0]?.statusReason)
        : undefined
  );
  return {
    messageId,
    state: aggregateSendState(receipts, effectiveReason),
    deliveries,
    receipts,
    accepted: receipts.length - rejected,
    rejected: rejectionReason === "sender_not_active" ? 1 : rejected,
    idempotentReplay,
    ...(effectiveReason ? { rejectionReason: effectiveReason } : {}),
  };
}

async function notifySessionReceipt(client: PoolClient, row: SessionInboxRecord): Promise<void> {
  const notification: SessionMessageStoreNotification = {
    version: 1,
    orgId: row.orgId ?? null,
    userId: row.userId,
    fromSessionKey: row.fromSessionKey,
    toSessionKey: row.toSessionKey,
    messageId: row.messageId ?? row.id,
    inboxId: row.id,
    status: row.status ?? "pending",
  };
  const payload = JSON.stringify(notification);
  if (Buffer.byteLength(payload, "utf8") >= 8_000) {
    throw new Error("session message notification exceeds Postgres payload limit");
  }
  await client.query("SELECT pg_notify($1, $2)", [SESSION_MESSAGE_NOTIFICATION_CHANNEL, payload]);
}

async function fetchSendReceipts(
  client: PoolClient,
  input: SessionMessageSendInput,
): Promise<SessionInboxRecord[]> {
  const result = await client.query<any>(
    `SELECT ${INBOX_COLUMNS} FROM session_inbox
      WHERE org_id = $1 AND user_id = $2 AND from_session_key = $3 AND message_id = $4
      ORDER BY created_at ASC, id ASC`,
    [dbOrgId(input.orgId), input.userId, input.fromSessionKey, input.messageId],
  );
  return result.rows.map(inboxRowToRecord);
}

async function insertReceipt(
  client: PoolClient,
  input: SessionMessageSendInput,
  recipient: string,
  status: SessionMessageStatus,
  reason: string | null,
  payloadJson: string,
  now: string,
  expiresAt: string,
  idFor: () => string,
): Promise<SessionInboxRecord> {
  const id = idFor();
  assertRouteText("receipt id", id);
  const terminalAt = TERMINAL_MESSAGE_STATUSES.has(status) ? now : null;
  const result = await client.query<any>(
    `INSERT INTO session_inbox (
       id, org_id, user_id, message_id, from_session_key, to_session_key,
       kind, payload_json, status, status_reason, created_at, updated_at,
       expires_at, terminal_at, sender_acknowledged_at, delivered_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,NULL,NULL)
     RETURNING ${INBOX_COLUMNS}`,
    [
      id, dbOrgId(input.orgId), input.userId, input.messageId,
      input.fromSessionKey, recipient, input.kind, payloadJson, status,
      reason, now, expiresAt, terminalAt,
    ],
  );
  const row = inboxRowToRecord(result.rows[0]);
  await notifySessionReceipt(client, row);
  return row;
}

async function expireDueRows(
  client: PoolClient,
  at: string,
  scope?: { orgId: string; userId: string; recipientKeys: string[] },
): Promise<SessionInboxRecord[]> {
  if (scope?.recipientKeys.length === 0) return [];
  const result = await client.query<any>(
    `UPDATE session_inbox
        SET status = 'expired', status_reason = COALESCE(status_reason, 'retention_expired'),
            updated_at = $1, terminal_at = $1
      WHERE status IN ('pending', 'held')
        AND expires_at::timestamptz <= $1::timestamptz
        ${scope ? "AND org_id = $2 AND user_id = $3 AND to_session_key = ANY($4::text[])" : ""}
      RETURNING ${INBOX_COLUMNS}`,
    scope ? [at, scope.orgId, scope.userId, scope.recipientKeys] : [at],
  );
  const rows = result.rows.map(inboxRowToRecord);
  for (const row of rows) await notifySessionReceipt(client, row);
  return rows;
}

export async function routeSessionMessage(
  exec: Executor,
  input: SessionMessageSendInput,
  options?: SessionMessageRouteOptions,
): Promise<SessionMessageSendResult> {
  assertRouteText("user id", input.userId);
  assertRouteText("message id", input.messageId);
  assertRouteText("sender session key", input.fromSessionKey);
  assertRouteText("recipient address", input.toSessionKey);
  if (input.orgId) assertRouteText("organization id", input.orgId);
  // Per-message payload identity fields are attacker-controlled. Strip them
  // before hashing/persistence; the active authenticated sender row supplies
  // those reserved slots after its lock is acquired.
  const contentPayload = senderContentPayload(input.payload);
  const payload = payloadForRoute(contentPayload);
  const now = routeNow(options?.now);
  const expiresAt = new Date(now.ms + SESSION_MESSAGE_PENDING_TTL_MS).toISOString();
  const idFor = options?.receiptIdGenerator ?? (() => randomUUID());
  const orgId = dbOrgId(input.orgId);

  return exec.tx(async (client) => {
    const senderProbeParams: unknown[] = [
      orgId, input.userId, input.fromSessionKey, ACTIVE_SESSION_STALE_MS,
    ];
    const senderClaimSql = input.senderClaimToken !== undefined
      ? ` AND claim_token = $${senderProbeParams.push(input.senderClaimToken)}`
      : "";
    const senderProbe = await client.query<{ session_key: string }>(
      `SELECT session_key FROM active_sessions
        WHERE org_id = $1 AND user_id = $2 AND session_key = $3
          AND last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - ($4 * interval '1 millisecond')
          AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP${senderClaimSql}`,
      senderProbeParams,
    );
    if (!senderProbe.rows[0]) {
      return sendResult(input.messageId, [], false, "sender_not_active");
    }

    const isBroadcast = input.toSessionKey === "*" || input.toSessionKey.toLowerCase() === "broadcast";
    const kindPattern = isBroadcast ? null : /^([^:]+):\*$/.exec(input.toSessionKey);
    const isExact = !isBroadcast && !kindPattern;
    let candidates: Array<{ session_key: string; client_kind: string }>;
    if (isBroadcast) {
      const result = await client.query<{ session_key: string; client_kind: string }>(
        `SELECT session_key, client_kind FROM active_sessions
          WHERE org_id = $1 AND user_id = $2 AND session_key <> $3
            AND last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - ($4 * interval '1 millisecond')
            AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP
          ORDER BY session_key ASC LIMIT $5`,
        [orgId, input.userId, input.fromSessionKey, ACTIVE_SESSION_STALE_MS, SESSION_MESSAGE_MAX_FANOUT + 1],
      );
      candidates = result.rows;
    } else if (kindPattern) {
      const result = await client.query<{ session_key: string; client_kind: string }>(
        `SELECT session_key, client_kind FROM active_sessions
          WHERE org_id = $1 AND user_id = $2 AND session_key <> $3
            AND client_kind = $4
            AND last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - ($5 * interval '1 millisecond')
            AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP
          ORDER BY session_key ASC LIMIT $6`,
        [
          orgId, input.userId, input.fromSessionKey, kindPattern[1],
          ACTIVE_SESSION_STALE_MS, SESSION_MESSAGE_MAX_FANOUT + 1,
        ],
      );
      candidates = result.rows;
    } else {
      const result = await client.query<{ session_key: string; client_kind: string }>(
        `SELECT session_key, client_kind FROM active_sessions
          WHERE org_id = $1 AND user_id = $2 AND session_key = $3
            AND session_key <> $4
            AND last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - ($5 * interval '1 millisecond')
            AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP`,
        [orgId, input.userId, input.toSessionKey, input.fromSessionKey, ACTIVE_SESSION_STALE_MS],
      );
      candidates = result.rows;
    }

    const keysToLock = [...new Set([input.fromSessionKey, ...candidates.map((row) => row.session_key)])].sort();
    const locked = await client.query<ActiveRouteRow>(
      `SELECT session_key, client_kind, workspace_root, metadata_json, claim_token FROM active_sessions
        WHERE org_id = $1 AND user_id = $2 AND session_key = ANY($3::text[])
          AND last_heartbeat_at::timestamptz >= CURRENT_TIMESTAMP - ($4 * interval '1 millisecond')
          AND claim_expires_at::timestamptz > CURRENT_TIMESTAMP
        ORDER BY org_id, user_id, session_key FOR UPDATE`,
      [orgId, input.userId, keysToLock, ACTIVE_SESSION_STALE_MS],
    );
    const lockedByKey = new Map(locked.rows.map((row) => [row.session_key, row]));
    const lockedSender = lockedByKey.get(input.fromSessionKey);
    if (!lockedSender || (input.senderClaimToken !== undefined && lockedSender.claim_token !== input.senderClaimToken)) {
      return sendResult(input.messageId, [], false, "sender_not_active");
    }
    const persistedPayloadJson = payloadForRoute(payloadWithAuthenticatedSender(
      contentPayload,
      lockedSender,
    )).json;
    candidates = candidates.filter((row) => {
      const lockedRow = lockedByKey.get(row.session_key);
      return lockedRow !== undefined && (!kindPattern || lockedRow.client_kind === kindPattern[1]);
    });

    const attempt = await client.query(
      `INSERT INTO session_message_sends
       (org_id, user_id, from_session_key, message_id, to_address, kind, payload_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, user_id, from_session_key, message_id) DO NOTHING
       RETURNING message_id`,
      [orgId, input.userId, input.fromSessionKey, input.messageId, input.toSessionKey, input.kind, payload.hash, now.iso],
    );
    if (attempt.rowCount === 0) {
      const existing = await client.query<{ to_address: string; kind: string; payload_hash: string }>(
        `SELECT to_address, kind, payload_hash FROM session_message_sends
          WHERE org_id = $1 AND user_id = $2 AND from_session_key = $3 AND message_id = $4`,
        [orgId, input.userId, input.fromSessionKey, input.messageId],
      );
      const first = existing.rows[0];
      if (!first || first.to_address !== input.toSessionKey || first.kind !== input.kind || first.payload_hash !== payload.hash) {
        const error = new Error("session message idempotency key was reused with different content") as Error & { code?: string };
        error.code = "SESSION_MESSAGE_IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return sendResult(input.messageId, await fetchSendReceipts(client, input), true);
    }

    if (candidates.length > SESSION_MESSAGE_MAX_FANOUT) {
      const receipt = await insertReceipt(
        client, input, input.toSessionKey, "rejected", "fanout_limit_exceeded",
        persistedPayloadJson, now.iso, expiresAt, idFor,
      );
      return sendResult(input.messageId, [receipt], false, "fanout_limit_exceeded");
    }

    if (candidates.length === 0) {
      const reason: SessionMessageRejectionReason = isExact && input.toSessionKey === input.fromSessionKey
        ? "self_send"
        : isExact ? "recipient_not_active" : "no_active_recipient";
      const receipt = await insertReceipt(
        client, input, input.toSessionKey, "rejected", reason,
        persistedPayloadJson, now.iso, expiresAt, idFor,
      );
      return sendResult(input.messageId, [receipt], false, reason);
    }

    const recipientKeys = candidates.map((row) => row.session_key);
    await expireDueRows(client, now.iso, { orgId, userId: input.userId, recipientKeys });
    const receipts: SessionInboxRecord[] = [];
    for (const recipient of recipientKeys) {
      const depth = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM session_inbox
          WHERE org_id = $1 AND user_id = $2 AND to_session_key = $3
            AND status IN ('pending', 'held')`,
        [orgId, input.userId, recipient],
      );
      const queueFull = Number(depth.rows[0]?.count ?? "0") >= SESSION_MESSAGE_MAX_PENDING_PER_RECIPIENT;
      receipts.push(await insertReceipt(
        client, input, recipient, queueFull ? "queue_full" : "pending",
        queueFull ? "queue_full" : null, persistedPayloadJson, now.iso, expiresAt, idFor,
      ));
    }
    return sendResult(input.messageId, receipts, false);
  });
}

export async function sendSessionMessage(
  exec: Executor,
  record: LegacySessionMessageSendInput,
  options?: LegacySessionMessageSendOptions,
): Promise<SessionInboxRecord[]> {
  const result = await routeSessionMessage(
    exec,
    {
      orgId: record.orgId ?? null,
      userId: record.userId,
      messageId: record.messageId ?? randomUUID(),
      fromSessionKey: record.fromSessionKey,
      toSessionKey: record.toSessionKey,
      kind: record.kind,
      payload: record.payload,
    },
    { now: options?.now, receiptIdGenerator: options?.idGenerator },
  );
  return result.deliveries;
}

export async function expireSessionMessages(exec: Executor, at?: string): Promise<number> {
  const now = routeNow(at).iso;
  return exec.tx(async (client) => (await expireDueRows(client, now)).length);
}

export async function readSessionInbox(exec: Executor, filters: SessionInboxFilters): Promise<SessionInboxRecord[]> {
  await expireSessionMessages(exec);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const statuses = filters.statuses ?? (filters.includeDelivered ? undefined : ["pending"]);
  if (statuses?.length === 0) return [];
  const params: unknown[] = [dbOrgId(filters.orgId), filters.userId, filters.toSessionKey];
  const claimSql = filters.claimToken !== undefined
    ? ` AND EXISTS (
        SELECT 1 FROM active_sessions AS claim
         WHERE claim.org_id = $1 AND claim.user_id = $2 AND claim.session_key = $3
           AND claim.claim_token = $${params.push(filters.claimToken)}
           AND claim.claim_expires_at::timestamptz > NOW()
      )`
    : "";
  const statusSql = statuses ? ` AND status = ANY($${params.push(statuses)}::text[])` : "";
  params.push(limit);
  const rows = await exec.rows<any>(
    `SELECT ${INBOX_COLUMNS} FROM session_inbox
      WHERE org_id = $1 AND user_id = $2 AND to_session_key = $3${claimSql}${statusSql}
      ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(inboxRowToRecord);
}

export async function transitionSessionMessages(
  exec: Executor,
  input: SessionMessageTransitionInput,
): Promise<SessionInboxRecord[]> {
  if (input.ids.length === 0) return [];
  const allowedFrom = input.toStatus === "held" ? ["pending"] : ["pending", "held"];
  const terminal = input.toStatus !== "held";
  return exec.tx(async (client) => {
    const result = await client.query<any>(
      `UPDATE session_inbox
          SET status = $1, status_reason = $2, updated_at = $3,
              terminal_at = CASE WHEN $4::boolean THEN COALESCE(terminal_at, $3) ELSE NULL END,
              delivered_at = CASE WHEN $1 = 'applied' THEN COALESCE(delivered_at, $3) ELSE delivered_at END
        WHERE org_id = $5 AND user_id = $6 AND to_session_key = $7
          AND id = ANY($8::text[]) AND status = ANY($9::text[])
          AND (NOT $10::boolean OR EXISTS (
            SELECT 1 FROM active_sessions AS claim
             WHERE claim.org_id = $5 AND claim.user_id = $6 AND claim.session_key = $7
               AND claim.claim_token = $11
               AND claim.claim_expires_at::timestamptz > CURRENT_TIMESTAMP
          ))
        RETURNING ${INBOX_COLUMNS}`,
      [
        input.toStatus, input.reason ?? null, input.at, terminal,
        dbOrgId(input.orgId), input.userId, input.toSessionKey,
        input.ids.slice(0, 500), allowedFrom,
        input.claimToken !== undefined, input.claimToken ?? "",
      ],
    );
    const rows = result.rows.map(inboxRowToRecord);
    for (const row of rows) await notifySessionReceipt(client, row);
    return rows;
  });
}

export async function ackSessionInbox(
  exec: Executor,
  userId: string,
  toSessionKey: string,
  ids: string[],
  at: string,
  orgId?: string | null,
  claimToken?: string,
): Promise<number> {
  return (await transitionSessionMessages(exec, {
    orgId: orgId ?? null,
    userId,
    toSessionKey,
    ids,
    toStatus: "applied",
    at,
    claimToken,
  })).length;
}

export async function readSessionMessageReceipts(
  exec: Executor,
  filters: SessionMessageReceiptFilters,
): Promise<SessionInboxRecord[]> {
  await expireSessionMessages(exec);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const params: unknown[] = [dbOrgId(filters.orgId), filters.userId, filters.fromSessionKey];
  let extra = "";
  if (filters.claimToken !== undefined) {
    extra += ` AND EXISTS (
      SELECT 1 FROM active_sessions AS claim
       WHERE claim.org_id = $1 AND claim.user_id = $2 AND claim.session_key = $3
         AND claim.claim_token = $${params.push(filters.claimToken)}
         AND claim.claim_expires_at::timestamptz > NOW()
    )`;
  }
  if (filters.messageId) extra += ` AND message_id = $${params.push(filters.messageId)}`;
  if (filters.statuses) {
    if (filters.statuses.length === 0) return [];
    extra += ` AND status = ANY($${params.push(filters.statuses)}::text[])`;
  }
  params.push(limit);
  const rows = await exec.rows<any>(
    `SELECT ${INBOX_COLUMNS} FROM session_inbox
      WHERE org_id = $1 AND user_id = $2 AND from_session_key = $3${extra}
      ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(inboxRowToRecord);
}

export async function ackSessionMessageReceipts(
  exec: Executor,
  input: SessionMessageReceiptAckInput,
): Promise<number> {
  if (input.ids.length === 0) return 0;
  return exec.run(
    `UPDATE session_inbox SET sender_acknowledged_at = $1
      WHERE org_id = $2 AND user_id = $3 AND from_session_key = $4
        AND terminal_at IS NOT NULL AND sender_acknowledged_at IS NULL
        AND id = ANY($5::text[])
        AND (NOT $6::boolean OR EXISTS (
          SELECT 1 FROM active_sessions AS claim
           WHERE claim.org_id = $2 AND claim.user_id = $3 AND claim.session_key = $4
             AND claim.claim_token = $7
             AND claim.claim_expires_at::timestamptz > CURRENT_TIMESTAMP
        ))`,
    [
      input.at, dbOrgId(input.orgId), input.userId, input.fromSessionKey,
      input.ids.slice(0, 500), input.claimToken !== undefined, input.claimToken ?? "",
    ],
  );
}

export async function sweepSessionInbox(exec: Executor, olderThanMs: number): Promise<number> {
  void olderThanMs;
  await expireSessionMessages(exec);
  const cutoff = new Date(Date.now() - SESSION_MESSAGE_TERMINAL_RETENTION_MS).toISOString();
  return exec.tx(async (client) => {
    const removed = await client.query(
      `DELETE FROM session_inbox
        WHERE terminal_at IS NOT NULL
          AND (sender_acknowledged_at IS NOT NULL OR terminal_at::timestamptz < $1::timestamptz)`,
      [cutoff],
    );
    await client.query(
      `DELETE FROM session_message_sends AS send
        WHERE send.created_at::timestamptz < $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM session_inbox AS inbox
             WHERE inbox.org_id = send.org_id AND inbox.user_id = send.user_id
               AND inbox.from_session_key = send.from_session_key
               AND inbox.message_id = send.message_id
          )`,
      [cutoff],
    );
    return removed.rowCount ?? 0;
  });
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
