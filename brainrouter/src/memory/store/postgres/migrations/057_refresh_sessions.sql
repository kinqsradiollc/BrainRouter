-- 057 — make a refresh token revocable.
--
-- Before this, `createRefreshToken` minted a plain signed JWT carrying only a
-- user id and a `type: "refresh"` marker, with no jti and no server-side record.
-- Three consequences, all of them bad and all of them silent:
--
--   * /signout could not revoke anything. It returned {success:true} and did
--     nothing — its own comment admitted a denylist was "future hardening".
--   * A password reset did not end existing sessions. A stolen 30-day token
--     outlived the password change made specifically to stop it.
--   * Rotation was cosmetic. /refresh issued a NEW token but the old one stayed
--     valid, so a stolen token could be used indefinitely alongside the victim's
--     and nothing could tell the difference.
--
-- The only revocation available was rotating BRAINROUTER_JWT_SECRET, which signs
-- out every user of the deployment.
--
-- A row per issued refresh token fixes all three. `token_hash` is a SHA-256 of
-- the raw token — the same one-way treatment `tenancy/tokens.ts` already applies
-- to invite and reset tokens — so a database leak does not hand over live
-- sessions. `replaced_by` records the rotation chain, which is what makes reuse
-- DETECTABLE: presenting a token that has already been replaced means either a
-- theft or a clone, and the correct response to both is to revoke the chain.
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoked_reason text,
  replaced_by  text,
  user_agent   text,
  ip           text
);

-- /refresh looks a token up by hash on every call: the hot path.
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_hash ON refresh_sessions (token_hash);
-- "revoke everything for this user" (password reset, signout-all, reuse detected).
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions (user_id, revoked_at, expires_at);

-- Manual rollback (ends every session; users re-authenticate):
--   DROP TABLE refresh_sessions;
