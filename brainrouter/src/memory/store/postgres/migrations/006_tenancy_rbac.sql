-- 006_tenancy_rbac.sql — ADR-010 P1: organization tenancy tier + RBAC.
--
-- Adds `organizations` + `org_members` (with a role) ABOVE the existing per-user
-- scope, and a `users.default_org_id` pointer. Backfills a personal org (plan
-- 'single') for every existing user as its `owner`, so single-user / local-first
-- keeps working with zero config and nothing regresses. The migration runner
-- wraps this file in a transaction, so the backfill is atomic.

CREATE TABLE IF NOT EXISTS organizations (
  org_id     text PRIMARY KEY,
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  plan       text NOT NULL DEFAULT 'single',   -- single | team | enterprise
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id     text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member',   -- owner | admin | member | viewer
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS default_org_id text REFERENCES organizations(org_id);

-- Backfill one deterministic personal org per existing user (idempotent: the
-- org_id is derived from the user id, guarded by NOT EXISTS + ON CONFLICT).
INSERT INTO organizations (org_id, name, slug, plan)
SELECT 'org_personal_' || u.user_id,
       COALESCE(NULLIF(u.display_name, ''), u.user_id) || ' (personal)',
       'personal-' || u.user_id,
       'single'
FROM users u
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO org_members (org_id, user_id, role)
SELECT 'org_personal_' || u.user_id, u.user_id, 'owner'
FROM users u
ON CONFLICT (org_id, user_id) DO NOTHING;

UPDATE users u
SET default_org_id = 'org_personal_' || u.user_id
WHERE u.default_org_id IS NULL;
