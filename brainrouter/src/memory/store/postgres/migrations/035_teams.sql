-- 035_teams — real teams sub-entity (a group of users WITHIN an org).
-- Meeting sharing (ADR-018) has a scope ladder private<team<org<public, but `team`
-- had no backing entity — tenancy modeled the org AS "the team" and migration 025 only
-- added a bare `team_id TEXT` column. This introduces first-class teams so `team` sharing
-- means "share to a specific team I belong to". Org-scoped: every team lives in exactly
-- one org and membership is checked against it. Additive; no existing table changes.
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,                 -- user who created the team
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- List an org's teams.
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (org_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
-- Resolve "the teams a user belongs to" for membership checks + listing.
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
