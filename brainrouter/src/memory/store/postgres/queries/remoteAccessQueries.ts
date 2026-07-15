import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";
import {
  REMOTE_AUDIT_EVENTS,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_STATUSES,
  REMOTE_GRANT_DECISIONS,
  fingerprintDevicePublicKey,
  isDeviceRefreshTokenHash,
  normalizeRemoteAccessScopes,
  type DeviceSessionInput,
  type DeviceSessionRecord,
  type DeviceSessionRotationInput,
  type DeviceSessionRotationResult,
  type RemoteAccessAuditInput,
  type RemoteAccessAuditRecord,
  type RemoteAccessGrantInput,
  type RemoteAccessGrantRecord,
  type RemoteDeviceInput,
  type RemoteDeviceKind,
  type RemoteDeviceRecord,
  type RemoteGrantDecision,
} from "../../../../remote/store.js";

type Row = Record<string, unknown>;

const DEVICE_COLS = `id, org_id, user_id, installation_id, kind, display_name,
  public_key, public_key_fingerprint, key_algorithm, status, enrolled_at,
  last_seen_at, revoked_at, created_at, updated_at`;
const SESSION_COLS = `id, family_id, org_id, user_id, device_id, generation,
  parent_session_id, replaced_by_session_id, expires_at, rotated_at,
  reuse_detected_at, revoked_at, revocation_reason, created_at, updated_at`;
const SESSION_COLS_FROM_S = `s.id, s.family_id, s.org_id, s.user_id, s.device_id, s.generation,
  s.parent_session_id, s.replaced_by_session_id, s.expires_at, s.rotated_at,
  s.reuse_detected_at, s.revoked_at, s.revocation_reason, s.created_at, s.updated_at`;
const GRANT_COLS = `id, org_id, user_id, desktop_device_id, mobile_device_id,
  scopes_json, approval_status, decided_at, decided_by_device_id, expires_at,
  revoked_at, revocation_reason, created_at, updated_at`;
const AUDIT_COLS = `id, org_id, user_id, event_type, actor_device_id,
  target_device_id, grant_id, session_family_id, scopes_json, reason_code,
  request_id, created_at`;

const stringValue = (value: unknown): string => value == null ? "" : String(value);
const nullableString = (value: unknown): string | null => value == null || value === "" ? null : String(value);
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : stringValue(value);
const nullableIso = (value: unknown): string | null => value == null ? null : iso(value);

function parsedScopes(value: unknown): RemoteAccessGrantRecord["scopes"] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return Array.isArray(parsed) && parsed.length > 0
      ? normalizeRemoteAccessScopes(parsed)
      : [];
  } catch {
    return [];
  }
}

function deviceFromRow(row: Row): RemoteDeviceRecord {
  const kind = stringValue(row.kind);
  const status = stringValue(row.status);
  return {
    id: stringValue(row.id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    installationId: stringValue(row.installation_id),
    kind: (REMOTE_DEVICE_KINDS as readonly string[]).includes(kind) ? kind as RemoteDeviceKind : "desktop",
    displayName: stringValue(row.display_name),
    publicKey: stringValue(row.public_key),
    publicKeyFingerprint: stringValue(row.public_key_fingerprint),
    keyAlgorithm: "ed25519",
    status: (REMOTE_DEVICE_STATUSES as readonly string[]).includes(status) ? status as RemoteDeviceRecord["status"] : "revoked",
    enrolledAt: iso(row.enrolled_at),
    lastSeenAt: nullableIso(row.last_seen_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sessionFromRow(row: Row): DeviceSessionRecord {
  return {
    id: stringValue(row.id),
    familyId: stringValue(row.family_id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    deviceId: stringValue(row.device_id),
    generation: Number(row.generation ?? 0),
    parentSessionId: nullableString(row.parent_session_id),
    replacedBySessionId: nullableString(row.replaced_by_session_id),
    expiresAt: iso(row.expires_at),
    rotatedAt: nullableIso(row.rotated_at),
    reuseDetectedAt: nullableIso(row.reuse_detected_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReason: nullableString(row.revocation_reason),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function grantFromRow(row: Row): RemoteAccessGrantRecord {
  const approval = stringValue(row.approval_status);
  return {
    id: stringValue(row.id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    desktopDeviceId: stringValue(row.desktop_device_id),
    mobileDeviceId: stringValue(row.mobile_device_id),
    scopes: parsedScopes(row.scopes_json),
    approvalStatus: approval === "approved" || approval === "denied" ? approval : "pending",
    decidedAt: nullableIso(row.decided_at),
    decidedByDeviceId: nullableString(row.decided_by_device_id),
    expiresAt: iso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReason: nullableString(row.revocation_reason),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function auditFromRow(row: Row): RemoteAccessAuditRecord {
  const event = stringValue(row.event_type);
  return {
    id: stringValue(row.id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    eventType: (REMOTE_AUDIT_EVENTS as readonly string[]).includes(event)
      ? event as RemoteAccessAuditRecord["eventType"]
      : "connection_closed",
    actorDeviceId: nullableString(row.actor_device_id),
    targetDeviceId: nullableString(row.target_device_id),
    grantId: nullableString(row.grant_id),
    sessionFamilyId: nullableString(row.session_family_id),
    scopes: parsedScopes(row.scopes_json),
    reasonCode: nullableString(row.reason_code),
    requestId: nullableString(row.request_id),
    createdAt: iso(row.created_at),
  };
}

function assertExpiration(expiresAt: string, now: string): void {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current) {
    throw new Error("Remote access expiry must be a valid time in the future");
  }
}

function normalizedReason(reasonCode: string): string {
  const reason = reasonCode.trim();
  if (!reason || reason.length > 120 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error("A short metadata-only revocation reason is required");
  }
  return reason;
}

export async function createRemoteDevice(
  exec: Executor,
  orgId: string,
  userId: string,
  input: RemoteDeviceInput,
  now = new Date().toISOString(),
): Promise<RemoteDeviceRecord> {
  const installationId = input.installationId.trim();
  const displayName = input.displayName.trim().slice(0, 128);
  if (installationId.length < 8 || installationId.length > 256) throw new Error("A stable installation id is required");
  if (!(REMOTE_DEVICE_KINDS as readonly string[]).includes(input.kind)) throw new Error("Remote device kind must be desktop or mobile");
  const publicKey = input.publicKey.trim();
  const fingerprint = fingerprintDevicePublicKey(publicKey);
  const id = `rdev_${randomUUID()}`;
  await exec.run(
    `INSERT INTO remote_devices (
       id, org_id, user_id, installation_id, kind, display_name, public_key,
       public_key_fingerprint, key_algorithm, status, enrolled_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ed25519','active',$9,$9,$9)`,
    [id, orgId, userId, installationId, input.kind, displayName, publicKey, fingerprint, now],
  );
  const created = await getRemoteDevice(exec, orgId, userId, id);
  if (!created) throw new Error("Enrolled remote device could not be loaded");
  return created;
}

export async function getRemoteDevice(exec: Executor, orgId: string, userId: string, deviceId: string): Promise<RemoteDeviceRecord | null> {
  const row = await exec.one(
    `SELECT ${DEVICE_COLS} FROM remote_devices WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [deviceId, orgId, userId],
  );
  return row ? deviceFromRow(row) : null;
}

export async function getRemoteDeviceByInstallation(exec: Executor, orgId: string, userId: string, installationId: string): Promise<RemoteDeviceRecord | null> {
  const row = await exec.one(
    `SELECT ${DEVICE_COLS} FROM remote_devices WHERE org_id = $1 AND user_id = $2 AND installation_id = $3`,
    [orgId, userId, installationId],
  );
  return row ? deviceFromRow(row) : null;
}

export async function listRemoteDevices(exec: Executor, orgId: string, userId: string, kind?: RemoteDeviceKind): Promise<RemoteDeviceRecord[]> {
  const rows = kind
    ? await exec.rows(`SELECT ${DEVICE_COLS} FROM remote_devices WHERE org_id = $1 AND user_id = $2 AND kind = $3 ORDER BY created_at ASC, id ASC`, [orgId, userId, kind])
    : await exec.rows(`SELECT ${DEVICE_COLS} FROM remote_devices WHERE org_id = $1 AND user_id = $2 ORDER BY kind, created_at ASC, id ASC`, [orgId, userId]);
  return rows.map(deviceFromRow);
}

export async function touchRemoteDevice(exec: Executor, orgId: string, userId: string, deviceId: string, at = new Date().toISOString()): Promise<boolean> {
  return (await exec.run(
    "UPDATE remote_devices SET last_seen_at = $4, updated_at = $4 WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = 'active'",
    [deviceId, orgId, userId, at],
  )) === 1;
}

export async function revokeRemoteDevice(exec: Executor, orgId: string, userId: string, deviceId: string, reasonCode: string, at = new Date().toISOString()): Promise<boolean> {
  const reason = normalizedReason(reasonCode);
  return exec.tx(async (client) => {
    const device = await client.query(
      `UPDATE remote_devices SET status = 'revoked', revoked_at = $4, updated_at = $4
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status <> 'revoked'`,
      [deviceId, orgId, userId, at],
    );
    if (device.rowCount !== 1) return false;
    await client.query(
      `UPDATE auth_device_sessions
       SET revoked_at = COALESCE(revoked_at, $4), revocation_reason = COALESCE(revocation_reason, $5), updated_at = $4
       WHERE device_id = $1 AND org_id = $2 AND user_id = $3`,
      [deviceId, orgId, userId, at, reason],
    );
    await client.query(
      `UPDATE remote_access_grants
       SET revoked_at = COALESCE(revoked_at, $4), revocation_reason = COALESCE(revocation_reason, $5), updated_at = $4
       WHERE org_id = $2 AND user_id = $3 AND (desktop_device_id = $1 OR mobile_device_id = $1)`,
      [deviceId, orgId, userId, at, reason],
    );
    return true;
  });
}

export async function createDeviceSession(exec: Executor, orgId: string, userId: string, input: DeviceSessionInput, now = new Date().toISOString()): Promise<DeviceSessionRecord> {
  if (!isDeviceRefreshTokenHash(input.tokenHash)) throw new Error("Device sessions accept only a SHA-256 token hash");
  assertExpiration(input.expiresAt, now);
  const id = `rds_${randomUUID()}`;
  const familyId = input.familyId?.trim() || `rfs_${randomUUID()}`;
  if (familyId.length > 128) throw new Error("Device session family id is too long");
  const inserted = await exec.run(
    `INSERT INTO auth_device_sessions (
       id, family_id, org_id, user_id, device_id, token_hash, generation,
       expires_at, created_at, updated_at
     )
     SELECT $1,$2,$3,$4,d.id,$6,0,$7,$8,$8
     FROM remote_devices d
     WHERE d.id = $5 AND d.org_id = $3 AND d.user_id = $4 AND d.status = 'active'`,
    [id, familyId, orgId, userId, input.deviceId, input.tokenHash, input.expiresAt, now],
  );
  if (inserted !== 1) throw new Error("An active enrolled device is required");
  const created = await getDeviceSession(exec, orgId, userId, id);
  if (!created) throw new Error("Device session could not be loaded");
  return created;
}

export async function getDeviceSession(exec: Executor, orgId: string, userId: string, sessionId: string): Promise<DeviceSessionRecord | null> {
  const row = await exec.one(
    `SELECT ${SESSION_COLS} FROM auth_device_sessions WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [sessionId, orgId, userId],
  );
  return row ? sessionFromRow(row) : null;
}

export async function getDeviceSessionByTokenHash(exec: Executor, orgId: string, userId: string, tokenHash: string): Promise<DeviceSessionRecord | null> {
  if (!isDeviceRefreshTokenHash(tokenHash)) return null;
  const row = await exec.one(
    `SELECT ${SESSION_COLS} FROM auth_device_sessions
     WHERE token_hash = $1 AND org_id = $2 AND user_id = $3`,
    [tokenHash, orgId, userId],
  );
  return row ? sessionFromRow(row) : null;
}

export async function rotateDeviceSession(
  exec: Executor,
  orgId: string,
  userId: string,
  input: DeviceSessionRotationInput,
  at = new Date().toISOString(),
): Promise<DeviceSessionRotationResult> {
  if (!isDeviceRefreshTokenHash(input.tokenHash) || !isDeviceRefreshTokenHash(input.nextTokenHash)) {
    throw new Error("Device session rotation accepts only SHA-256 token hashes");
  }
  if (input.tokenHash === input.nextTokenHash) throw new Error("Device refresh-token rotation requires a new token hash");
  assertExpiration(input.nextExpiresAt, at);

  return exec.tx(async (client) => {
    const selected = await client.query(
      `SELECT ${SESSION_COLS_FROM_S}, d.status AS device_status
       FROM auth_device_sessions s
       JOIN remote_devices d ON d.id = s.device_id AND d.org_id = s.org_id AND d.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.org_id = $2 AND s.user_id = $3
       FOR UPDATE OF s`,
      [input.tokenHash, orgId, userId],
    );
    const row = selected.rows[0] as Row | undefined;
    if (!row) return { status: "invalid" };

    if (row.reuse_detected_at || row.rotated_at || row.replaced_by_session_id) {
      await client.query(
        `UPDATE auth_device_sessions
         SET reuse_detected_at = COALESCE(reuse_detected_at, $4),
             revoked_at = COALESCE(revoked_at, $4),
             revocation_reason = 'refresh_token_reuse', updated_at = $4
         WHERE family_id = $1 AND org_id = $2 AND user_id = $3`,
        [row.family_id, orgId, userId, at],
      );
      return { status: "reuse-detected" };
    }
    if (row.revoked_at || row.device_status !== "active") return { status: "revoked" };
    if (Date.parse(iso(row.expires_at)) <= Date.parse(at)) {
      await client.query(
        `UPDATE auth_device_sessions SET revoked_at = $4, revocation_reason = 'expired', updated_at = $4
         WHERE id = $1 AND org_id = $2 AND user_id = $3`,
        [row.id, orgId, userId, at],
      );
      return { status: "expired" };
    }

    const nextId = `rds_${randomUUID()}`;
    const created = await client.query(
      `INSERT INTO auth_device_sessions (
         id, family_id, org_id, user_id, device_id, token_hash, generation,
         parent_session_id, expires_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING ${SESSION_COLS}`,
      [nextId, row.family_id, orgId, userId, row.device_id, input.nextTokenHash, Number(row.generation ?? 0) + 1, row.id, input.nextExpiresAt, at],
    );
    await client.query(
      `UPDATE auth_device_sessions
       SET rotated_at = $4, replaced_by_session_id = $5, updated_at = $4
       WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [row.id, orgId, userId, at, nextId],
    );
    return { status: "rotated", session: sessionFromRow(created.rows[0] as Row) };
  });
}

export async function revokeDeviceSessionFamily(exec: Executor, orgId: string, userId: string, familyId: string, reasonCode: string, at = new Date().toISOString()): Promise<boolean> {
  const reason = normalizedReason(reasonCode);
  return (await exec.run(
    `UPDATE auth_device_sessions
     SET revoked_at = COALESCE(revoked_at, $4), revocation_reason = COALESCE(revocation_reason, $5), updated_at = $4
     WHERE family_id = $1 AND org_id = $2 AND user_id = $3`,
    [familyId, orgId, userId, at, reason],
  )) > 0;
}

export async function createRemoteAccessGrant(exec: Executor, orgId: string, userId: string, input: RemoteAccessGrantInput, now = new Date().toISOString()): Promise<RemoteAccessGrantRecord> {
  if (input.desktopDeviceId === input.mobileDeviceId) throw new Error("Remote access grants require two distinct devices");
  const scopes = normalizeRemoteAccessScopes(input.scopes);
  assertExpiration(input.expiresAt, now);
  const id = `rgrant_${randomUUID()}`;
  const inserted = await exec.run(
    `INSERT INTO remote_access_grants (
       id, org_id, user_id, desktop_device_id, mobile_device_id, scopes_json,
       approval_status, expires_at, created_at, updated_at
     )
     SELECT $1,$2,$3,desktop.id,mobile.id,$6,'pending',$7,$8,$8
     FROM remote_devices desktop
     JOIN remote_devices mobile ON mobile.org_id = desktop.org_id AND mobile.user_id = desktop.user_id
     WHERE desktop.id = $4 AND mobile.id = $5
       AND desktop.org_id = $2 AND desktop.user_id = $3
       AND desktop.kind = 'desktop' AND mobile.kind = 'mobile'
       AND desktop.status = 'active' AND mobile.status = 'active'`,
    [id, orgId, userId, input.desktopDeviceId, input.mobileDeviceId, JSON.stringify(scopes), input.expiresAt, now],
  );
  if (inserted !== 1) throw new Error("An active desktop and mobile owned by the same user are required");
  const created = await getRemoteAccessGrant(exec, orgId, userId, id);
  if (!created) throw new Error("Remote access grant could not be loaded");
  return created;
}

export async function getRemoteAccessGrant(exec: Executor, orgId: string, userId: string, grantId: string): Promise<RemoteAccessGrantRecord | null> {
  const row = await exec.one(
    `SELECT ${GRANT_COLS} FROM remote_access_grants WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [grantId, orgId, userId],
  );
  return row ? grantFromRow(row) : null;
}

export async function listRemoteAccessGrants(exec: Executor, orgId: string, userId: string): Promise<RemoteAccessGrantRecord[]> {
  const rows = await exec.rows(
    `SELECT ${GRANT_COLS} FROM remote_access_grants
     WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC, id DESC`,
    [orgId, userId],
  );
  return rows.map(grantFromRow);
}

export async function decideRemoteAccessGrant(
  exec: Executor,
  orgId: string,
  userId: string,
  grantId: string,
  desktopDeviceId: string,
  decision: RemoteGrantDecision,
  at = new Date().toISOString(),
): Promise<RemoteAccessGrantRecord | null> {
  if (!(REMOTE_GRANT_DECISIONS as readonly string[]).includes(decision)) throw new Error("Grant decision must be approved or denied");
  const changed = await exec.run(
    `UPDATE remote_access_grants g
     SET approval_status = $5, decided_at = $6, decided_by_device_id = $4, updated_at = $6
     WHERE g.id = $1 AND g.org_id = $2 AND g.user_id = $3
       AND g.desktop_device_id = $4 AND g.approval_status = 'pending'
       AND g.revoked_at IS NULL AND g.expires_at > $6
       AND EXISTS (
         SELECT 1 FROM remote_devices d
         WHERE d.id = $4 AND d.org_id = $2 AND d.user_id = $3
           AND d.kind = 'desktop' AND d.status = 'active'
       )`,
    [grantId, orgId, userId, desktopDeviceId, decision, at],
  );
  return changed === 1 ? getRemoteAccessGrant(exec, orgId, userId, grantId) : null;
}

export async function revokeRemoteAccessGrant(exec: Executor, orgId: string, userId: string, grantId: string, reasonCode: string, at = new Date().toISOString()): Promise<boolean> {
  const reason = normalizedReason(reasonCode);
  return (await exec.run(
    `UPDATE remote_access_grants
     SET revoked_at = $4, revocation_reason = $5, updated_at = $4
     WHERE id = $1 AND org_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [grantId, orgId, userId, at, reason],
  )) === 1;
}

const AUDIT_KEYS = new Set([
  "eventType", "actorDeviceId", "targetDeviceId", "grantId",
  "sessionFamilyId", "scopes", "reasonCode", "requestId",
]);

function normalizedAuditValue(value: string | null | undefined, field: "reasonCode" | "requestId"): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  const max = field === "reasonCode" ? 120 : 160;
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Remote audit ${field} is invalid`);
  }
  return normalized;
}

export async function appendRemoteAccessAudit(
  exec: Executor,
  orgId: string,
  userId: string,
  input: RemoteAccessAuditInput,
  at = new Date().toISOString(),
): Promise<RemoteAccessAuditRecord> {
  if (Object.keys(input as unknown as Record<string, unknown>).some((key) => !AUDIT_KEYS.has(key))) {
    throw new Error("Remote audit accepts metadata fields only");
  }
  if (!(REMOTE_AUDIT_EVENTS as readonly string[]).includes(input.eventType)) throw new Error("Unknown remote audit event");
  const scopes = input.scopes?.length ? normalizeRemoteAccessScopes(input.scopes) : [];
  const reasonCode = normalizedAuditValue(input.reasonCode, "reasonCode");
  const requestId = normalizedAuditValue(input.requestId, "requestId");

  for (const deviceId of [input.actorDeviceId, input.targetDeviceId]) {
    if (deviceId && !await getRemoteDevice(exec, orgId, userId, deviceId)) {
      throw new Error("Remote audit device is outside the active user and organization scope");
    }
  }
  if (input.grantId && !await getRemoteAccessGrant(exec, orgId, userId, input.grantId)) {
    throw new Error("Remote audit grant is outside the active user and organization scope");
  }
  if (input.sessionFamilyId) {
    const family = await exec.one(
      `SELECT 1 AS ok FROM auth_device_sessions
       WHERE family_id = $1 AND org_id = $2 AND user_id = $3 LIMIT 1`,
      [input.sessionFamilyId, orgId, userId],
    );
    if (!family) throw new Error("Remote audit session family is outside the active user and organization scope");
  }

  const id = `raud_${randomUUID()}`;
  const params = [
    id, orgId, userId, input.eventType, input.actorDeviceId ?? null,
    input.targetDeviceId ?? null, input.grantId ?? null, input.sessionFamilyId ?? null,
    JSON.stringify(scopes), reasonCode, requestId, at,
  ];
  await exec.run(
    `INSERT INTO remote_access_audit (
       id, org_id, user_id, event_type, actor_device_id, target_device_id,
       grant_id, session_family_id, scopes_json, reason_code, request_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    params,
  );
  return auditFromRow({
    id, org_id: orgId, user_id: userId, event_type: input.eventType,
    actor_device_id: input.actorDeviceId ?? null,
    target_device_id: input.targetDeviceId ?? null,
    grant_id: input.grantId ?? null,
    session_family_id: input.sessionFamilyId ?? null,
    scopes_json: JSON.stringify(scopes), reason_code: reasonCode,
    request_id: requestId, created_at: at,
  });
}

export async function listRemoteAccessAudit(exec: Executor, orgId: string, userId: string, limit = 100): Promise<RemoteAccessAuditRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  const rows = await exec.rows(
    `SELECT ${AUDIT_COLS} FROM remote_access_audit
     WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
    [orgId, userId, bounded],
  );
  return rows.map(auditFromRow);
}
