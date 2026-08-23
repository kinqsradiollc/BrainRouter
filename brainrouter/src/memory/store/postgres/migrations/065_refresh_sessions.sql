-- ADR-037 B1 — the refresh token becomes revocable.
--
-- Before this, the refresh token was a bare signed JWT with no server-side row:
-- /signout could only pretend, a password reset left stolen tokens valid for
-- their full 30 days, and rotation minted a new token while leaving the old one
-- live. The revocable-session module (refreshSessions.ts) was written and
-- unit-tested but never given a table, so it was dead code. This is that table.
--
-- The token is stored HASHED (sha256), never raw, so a database read yields no
-- live session — the same treatment auth_tokens already gives verification and
-- reset tokens. `replaced_by` records rotation (a used token points at its
-- successor) so reuse of an already-rotated token is detectable as theft.
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  replaced_by    text
);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions (user_id);
