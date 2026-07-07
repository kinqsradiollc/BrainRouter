-- 012_email_auth (ADR-014 Phase B2) — email verification, invitations, password
-- reset, and a system-settings KV (for SMTP config, kept out of .env).

-- System settings: one row per key, JSON value (SMTP config lives under 'email').
CREATE TABLE IF NOT EXISTS system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at text NOT NULL
);

-- Email verification state. Existing users are grandfathered as verified so the
-- new gate never locks anyone out; only NEW signups start unverified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
UPDATE users SET email_verified = true WHERE email_verified = false;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;

-- Short-lived, single-use tokens for email verification + password reset. Only the
-- SHA-256 HASH is stored; the raw token is emailed and never persisted.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL,              -- 'email_verify' | 'password_reset'
  user_id    text,
  email      text,
  expires_at text NOT NULL,
  consumed_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

-- Pending organization invitations (invite by email before the person has an
-- account). Hash-only, single-use, expiring.
CREATE TABLE IF NOT EXISTS org_invites (
  token_hash text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  email      text NOT NULL,
  role       text NOT NULL,
  invited_by text,
  expires_at text NOT NULL,
  accepted_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(lower(email));
