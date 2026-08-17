/**
 * ADR-037 B1 — Postgres backing for the revocable refresh-session store.
 * Free functions over the shared Executor (like emailAuthQueries), assembled
 * into the `RefreshSessionStore` shape the pure lifecycle module expects. The
 * token is only ever stored/looked-up by its sha256 hash.
 */
import type { Executor } from "./executor.js";
import type { RefreshSessionStore, RefreshSessionRow } from "../../../../api/routes/identity/refreshSessions.js";

function mapRow(row: any): RefreshSessionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    issuedAt: new Date(row.issued_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
    replacedBy: row.replaced_by ? String(row.replaced_by) : null,
  };
}

export function makeRefreshSessionStore(exec: Executor): RefreshSessionStore {
  return {
    async insert(row) {
      await exec.run(
        `INSERT INTO refresh_sessions (id, user_id, token_hash, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.userId, row.tokenHash, row.issuedAt.toISOString(), row.expiresAt.toISOString()],
      );
    },
    async findByHash(tokenHash) {
      const row = await exec.one(
        `SELECT id, user_id, token_hash, issued_at, expires_at, revoked_at, revoked_reason, replaced_by
           FROM refresh_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      return row ? mapRow(row) : null;
    },
    async markReplaced(id, replacedBy) {
      await exec.run(`UPDATE refresh_sessions SET replaced_by = $2 WHERE id = $1`, [id, replacedBy]);
    },
    async revokeById(id, reason) {
      await exec.run(
        `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [id, reason],
      );
    },
    async revokeAllForUser(userId, reason) {
      return await exec.run(
        `UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, reason],
      );
    },
  };
}
