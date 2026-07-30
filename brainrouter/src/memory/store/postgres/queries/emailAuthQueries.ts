/**
 * Email/auth persistence (ADR-014 Phase B2) — system settings (SMTP config),
 * single-use auth tokens (email verification + password reset), and org
 * invitations. Free functions over the shared Executor, like tenancyQueries.
 */
import type { Executor } from "./executor.js";

export interface AuthTokenRecord {
  tokenHash: string;
  kind: string;
  userId: string | null;
  email: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface OrgInviteRecord {
  tokenHash: string;
  orgId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

// ── system settings (KV) ─────────────────────────────────────────────────
export async function getSetting<T = unknown>(exec: Executor, key: string): Promise<T | null> {
  const row = await exec.one(`SELECT value FROM system_settings WHERE key = $1`, [key]);
  return row ? (row.value as T) : null;
}

export async function setSetting(exec: Executor, key: string, value: unknown, now: string): Promise<void> {
  await exec.run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), now],
  );
}

// ── auth tokens (email verify / password reset) ──────────────────────────
export async function createAuthToken(
  exec: Executor,
  rec: { tokenHash: string; kind: string; userId?: string | null; email?: string | null; expiresAt: string; createdAt: string },
): Promise<void> {
  await exec.run(
    `INSERT INTO auth_tokens (token_hash, kind, user_id, email, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [rec.tokenHash, rec.kind, rec.userId ?? null, rec.email ?? null, rec.expiresAt, rec.createdAt],
  );
}

/** Atomically consume a token: valid iff unconsumed + unexpired. Returns it or null. */
export async function consumeAuthToken(
  exec: Executor,
  tokenHash: string,
  kind: string,
  now: string,
): Promise<AuthTokenRecord | null> {
  const row = await exec.one(
    `UPDATE auth_tokens SET consumed_at = $3
       WHERE token_hash = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > $3
     RETURNING token_hash, kind, user_id, email, expires_at, consumed_at, created_at`,
    [tokenHash, kind, now],
  );
  if (!row) return null;
  return {
    tokenHash: String(row.token_hash), kind: String(row.kind),
    userId: row.user_id ? String(row.user_id) : null, email: row.email ? String(row.email) : null,
    expiresAt: String(row.expires_at), consumedAt: row.consumed_at ? String(row.consumed_at) : null,
    createdAt: String(row.created_at),
  };
}

export async function setEmailVerified(exec: Executor, userId: string): Promise<void> {
  await exec.run(`UPDATE users SET email_verified = true WHERE user_id = $1`, [userId]);
}

// ── org invitations ──────────────────────────────────────────────────────
function inviteRow(row: any): OrgInviteRecord {
  return {
    tokenHash: String(row.token_hash), orgId: String(row.org_id), email: String(row.email),
    role: String(row.role), invitedBy: row.invited_by ? String(row.invited_by) : null,
    expiresAt: String(row.expires_at), acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    createdAt: String(row.created_at),
  };
}

export async function createInvite(exec: Executor, rec: OrgInviteRecord): Promise<void> {
  await exec.run(
    `INSERT INTO org_invites (token_hash, org_id, email, role, invited_by, expires_at, accepted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [rec.tokenHash, rec.orgId, rec.email, rec.role, rec.invitedBy, rec.expiresAt, rec.acceptedAt, rec.createdAt],
  );
}

export async function getInviteByHash(exec: Executor, tokenHash: string): Promise<OrgInviteRecord | null> {
  const row = await exec.one(
    `SELECT token_hash, org_id, email, role, invited_by, expires_at, accepted_at, created_at
       FROM org_invites WHERE token_hash = $1`,
    [tokenHash],
  );
  return row ? inviteRow(row) : null;
}

/** Mark an invite accepted iff still pending. Returns the invite or null. */
export async function acceptInvite(exec: Executor, tokenHash: string, now: string): Promise<OrgInviteRecord | null> {
  const row = await exec.one(
    `UPDATE org_invites SET accepted_at = $2
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2
     RETURNING token_hash, org_id, email, role, invited_by, expires_at, accepted_at, created_at`,
    [tokenHash, now],
  );
  return row ? inviteRow(row) : null;
}

export async function listInvites(exec: Executor, orgId: string): Promise<OrgInviteRecord[]> {
  const rows = await exec.rows(
    `SELECT token_hash, org_id, email, role, invited_by, expires_at, accepted_at, created_at
       FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(inviteRow);
}

export async function revokeInvite(exec: Executor, tokenHash: string): Promise<void> {
  await exec.run(`DELETE FROM org_invites WHERE token_hash = $1`, [tokenHash]);
}
