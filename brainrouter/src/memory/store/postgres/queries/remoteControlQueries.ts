import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";
import {
  REMOTE_DEVICE_KINDS,
  fingerprintDevicePublicKey,
  normalizeRemoteAccessScopes,
  type RemoteAccessScope,
  type RemoteEnrollmentChallengeInput,
  type RemoteEnrollmentChallengeRecord,
  type RemoteRelayTicketInput,
  type RemoteRelayTicketRecord,
  type RemoteRelayTicketRevocation,
} from "../../../../remote/store.js";

type Row = Record<string, unknown>;

export const REMOTE_REVOCATION_CHANNEL = "brainrouter_remote_revocations";

const CHALLENGE_COLS = `id, org_id, user_id, installation_id, kind, display_name,
  public_key, public_key_fingerprint, expires_at, consumed_at, created_at`;
const TICKET_COLS = `id, org_id, user_id, presenting_device_id, peer_device_id,
  grant_id, session_family_id, audience, scopes_json, expires_at, consumed_at,
  revoked_at, revocation_reason, created_at`;

const stringValue = (value: unknown): string => value == null ? "" : String(value);
const nullableString = (value: unknown): string | null => value == null || value === "" ? null : String(value);
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : stringValue(value);
const nullableIso = (value: unknown): string | null => value == null ? null : iso(value);

function scopesFrom(value: unknown): RemoteAccessScope[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return Array.isArray(parsed) && parsed.length > 0 ? normalizeRemoteAccessScopes(parsed) : [];
  } catch {
    return [];
  }
}

function challengeFromRow(row: Row): RemoteEnrollmentChallengeRecord {
  const kind = stringValue(row.kind);
  return {
    id: stringValue(row.id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    installationId: stringValue(row.installation_id),
    kind: (REMOTE_DEVICE_KINDS as readonly string[]).includes(kind) ? kind as RemoteEnrollmentChallengeRecord["kind"] : "desktop",
    displayName: stringValue(row.display_name),
    publicKey: stringValue(row.public_key),
    publicKeyFingerprint: stringValue(row.public_key_fingerprint),
    expiresAt: iso(row.expires_at),
    consumedAt: nullableIso(row.consumed_at),
    createdAt: iso(row.created_at),
  };
}

function ticketFromRow(row: Row): RemoteRelayTicketRecord {
  return {
    id: stringValue(row.id),
    orgId: stringValue(row.org_id),
    userId: stringValue(row.user_id),
    presentingDeviceId: stringValue(row.presenting_device_id),
    peerDeviceId: stringValue(row.peer_device_id),
    grantId: stringValue(row.grant_id),
    sessionFamilyId: stringValue(row.session_family_id),
    audience: "remote-relay",
    scopes: scopesFrom(row.scopes_json),
    expiresAt: iso(row.expires_at),
    consumedAt: nullableIso(row.consumed_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReason: nullableString(row.revocation_reason),
    createdAt: iso(row.created_at),
  };
}

function assertHash(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
}

function assertWindow(expiresAt: string, at: string, minimumMs: number, maximumMs: number, label: string): void {
  const duration = Date.parse(expiresAt) - Date.parse(at);
  if (!Number.isFinite(duration) || duration < minimumMs || duration > maximumMs) {
    throw new Error(`${label} expiry is outside its allowed window`);
  }
}

function normalizedReason(reasonCode: string): string {
  const reason = reasonCode.trim();
  if (!reason || reason.length > 120 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error("A short metadata-only relay revocation reason is required");
  }
  return reason;
}

export async function createRemoteEnrollmentChallenge(
  exec: Executor,
  orgId: string,
  userId: string,
  input: RemoteEnrollmentChallengeInput,
  at = new Date().toISOString(),
): Promise<RemoteEnrollmentChallengeRecord> {
  assertHash(input.challengeHash, "Enrollment challenge");
  assertWindow(input.expiresAt, at, 1, 10 * 60_000, "Enrollment challenge");
  const installationId = input.installationId.trim();
  const publicKey = input.publicKey.trim();
  const fingerprint = fingerprintDevicePublicKey(publicKey);
  const id = `rench_${randomUUID()}`;
  const row = await exec.one(
    `INSERT INTO remote_enrollment_challenges (
       id, org_id, user_id, installation_id, kind, display_name, public_key,
       public_key_fingerprint, challenge_hash, expires_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${CHALLENGE_COLS}`,
    [id, orgId, userId, installationId, input.kind, input.displayName.trim().slice(0, 128), publicKey, fingerprint, input.challengeHash, input.expiresAt, at],
  );
  if (!row) throw new Error("Enrollment challenge could not be created");
  return challengeFromRow(row);
}

export async function getRemoteEnrollmentChallenge(
  exec: Executor,
  orgId: string,
  userId: string,
  challengeId: string,
): Promise<RemoteEnrollmentChallengeRecord | null> {
  const row = await exec.one(
    `SELECT ${CHALLENGE_COLS} FROM remote_enrollment_challenges
     WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [challengeId, orgId, userId],
  );
  return row ? challengeFromRow(row) : null;
}

export async function consumeRemoteEnrollmentChallenge(
  exec: Executor,
  orgId: string,
  userId: string,
  challengeId: string,
  challengeHash: string,
  at = new Date().toISOString(),
): Promise<boolean> {
  assertHash(challengeHash, "Enrollment challenge");
  return (await exec.run(
    `UPDATE remote_enrollment_challenges SET consumed_at = $5
     WHERE id = $1 AND org_id = $2 AND user_id = $3 AND challenge_hash = $4
       AND consumed_at IS NULL AND expires_at > $5`,
    [challengeId, orgId, userId, challengeHash, at],
  )) === 1;
}

export async function createRemoteRelayTicket(
  exec: Executor,
  orgId: string,
  userId: string,
  input: RemoteRelayTicketInput,
  at = new Date().toISOString(),
): Promise<RemoteRelayTicketRecord> {
  assertHash(input.tokenHash, "Relay ticket");
  if (input.audience !== "remote-relay") throw new Error("Relay ticket audience is invalid");
  const scopes = normalizeRemoteAccessScopes(input.scopes);
  assertWindow(input.expiresAt, at, 30_000, 60_000, "Relay ticket");
  const id = `rrs_${randomUUID()}`;
  const row = await exec.one(
    `INSERT INTO remote_relay_tickets (
       id, token_hash, org_id, user_id, presenting_device_id, peer_device_id,
       grant_id, session_family_id, audience, scopes_json, expires_at, created_at
     )
     SELECT $1,$2,$3,$4,presenting.id,peer.id,g.id,s.family_id,$9,$10,$11,$12
     FROM remote_devices presenting
     JOIN remote_devices peer ON peer.org_id = presenting.org_id AND peer.user_id = presenting.user_id
     JOIN remote_access_grants g ON g.org_id = presenting.org_id AND g.user_id = presenting.user_id
     JOIN auth_device_sessions s ON s.org_id = presenting.org_id AND s.user_id = presenting.user_id
     WHERE presenting.id = $5 AND peer.id = $6 AND g.id = $7 AND s.id = $8
       AND presenting.org_id = $3 AND presenting.user_id = $4
       AND presenting.kind = 'mobile' AND peer.kind = 'desktop'
       AND presenting.status = 'active' AND peer.status = 'active'
       AND g.mobile_device_id = presenting.id AND g.desktop_device_id = peer.id
       AND g.approval_status = 'approved' AND g.revoked_at IS NULL AND g.expires_at > $12
       AND $10::jsonb <@ g.scopes_json::jsonb
       AND s.device_id = presenting.id AND s.revoked_at IS NULL
       AND s.reuse_detected_at IS NULL AND s.rotated_at IS NULL
       AND s.replaced_by_session_id IS NULL AND s.expires_at > $12
     RETURNING ${TICKET_COLS}`,
    [id, input.tokenHash, orgId, userId, input.presentingDeviceId, input.peerDeviceId, input.grantId, input.deviceSessionId, input.audience, JSON.stringify(scopes), input.expiresAt, at],
  );
  if (!row) throw new Error("Relay ticket requires active scoped devices, session, and approved grant");
  return ticketFromRow(row);
}

/** Atomic compare-and-consume. Wrong binding, expiry, revocation, or replay returns null. */
export async function consumeRemoteRelayTicket(
  exec: Executor,
  tokenHash: string,
  audience: "remote-relay",
  presentingDeviceId: string,
  at = new Date().toISOString(),
): Promise<RemoteRelayTicketRecord | null> {
  assertHash(tokenHash, "Relay ticket");
  const row = await exec.one(
    `UPDATE remote_relay_tickets t SET consumed_at = $4
     WHERE t.token_hash = $1 AND t.audience = $2 AND t.presenting_device_id = $3
       AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > $4
       AND EXISTS (
         SELECT 1 FROM remote_devices presenting, remote_devices peer
         WHERE presenting.id = t.presenting_device_id AND peer.id = t.peer_device_id
           AND presenting.org_id = t.org_id AND presenting.user_id = t.user_id
           AND peer.org_id = t.org_id AND peer.user_id = t.user_id
           AND presenting.status = 'active' AND peer.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM remote_access_grants g
         WHERE g.id = t.grant_id AND g.org_id = t.org_id AND g.user_id = t.user_id
           AND g.mobile_device_id = t.presenting_device_id AND g.desktop_device_id = t.peer_device_id
           AND g.approval_status = 'approved' AND g.revoked_at IS NULL AND g.expires_at > $4
           AND t.scopes_json::jsonb <@ g.scopes_json::jsonb
       )
       AND EXISTS (
         SELECT 1 FROM auth_device_sessions s
         WHERE s.family_id = t.session_family_id AND s.org_id = t.org_id AND s.user_id = t.user_id
           AND s.device_id = t.presenting_device_id AND s.revoked_at IS NULL
           AND s.reuse_detected_at IS NULL AND s.rotated_at IS NULL
           AND s.replaced_by_session_id IS NULL AND s.expires_at > $4
       )
     RETURNING ${TICKET_COLS}`,
    [tokenHash, audience, presentingDeviceId, at],
  );
  return row ? ticketFromRow(row) : null;
}

/** Revoke matching tickets and emit a metadata-only event for active relay instances. */
export async function revokeRemoteRelayTickets(
  exec: Executor,
  orgId: string,
  userId: string,
  selector: RemoteRelayTicketRevocation,
  reasonCode: string,
  at = new Date().toISOString(),
): Promise<number> {
  const reason = normalizedReason(reasonCode);
  const conditions = ["org_id = $1", "user_id = $2", "revoked_at IS NULL"];
  const params: string[] = [orgId, userId];
  if (selector.deviceId) {
    params.push(selector.deviceId);
    conditions.push(`(presenting_device_id = $${params.length} OR peer_device_id = $${params.length})`);
  }
  if (selector.grantId) {
    params.push(selector.grantId);
    conditions.push(`grant_id = $${params.length}`);
  }
  if (selector.sessionFamilyId) {
    params.push(selector.sessionFamilyId);
    conditions.push(`session_family_id = $${params.length}`);
  }
  params.push(at, reason);
  const atParam = params.length - 1;
  const reasonParam = params.length;

  return exec.tx(async (client) => {
    const result = await client.query(
      `UPDATE remote_relay_tickets
       SET revoked_at = $${atParam}, revocation_reason = $${reasonParam}
       WHERE ${conditions.join(" AND ")}
       RETURNING id`,
      params,
    );
    const payload = JSON.stringify({
      orgId,
      userId,
      deviceId: selector.deviceId ?? null,
      grantId: selector.grantId ?? null,
      sessionFamilyId: selector.sessionFamilyId ?? null,
      reasonCode: reason,
      revokedAt: at,
    });
    await client.query("SELECT pg_notify($1, $2)", [REMOTE_REVOCATION_CHANNEL, payload]);
    return result.rowCount ?? 0;
  });
}
