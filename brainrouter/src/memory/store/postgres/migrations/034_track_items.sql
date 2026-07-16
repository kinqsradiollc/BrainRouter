-- 034_track_items — Track (Jira-class PM) server plane.
-- Track used to be a LOCAL per-workspace `track.json` (desktop/CLI only), so it could
-- not be viewed on the web dashboard and never synced across surfaces. This gives it a
-- shared, org-scoped, collaborative home — mirroring the meetings plane — so meeting→Track,
-- done-state, and untrack work across desktop + dashboard. Additive; no existing table changes.
CREATE TABLE IF NOT EXISTS track_items (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  user_id          TEXT NOT NULL,                 -- creator
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL DEFAULT 'task',
  status           TEXT NOT NULL DEFAULT 'todo',
  status_category  TEXT NOT NULL DEFAULT 'todo',  -- todo | in_progress | completed
  priority         TEXT NOT NULL DEFAULT 'medium',
  assignee         TEXT,
  labels_json      TEXT NOT NULL DEFAULT '[]',
  source           TEXT NOT NULL DEFAULT 'manual',-- manual | meeting-action
  source_ref       TEXT,                          -- origin key, e.g. "<meetingId>:<actionId>"
  completed_at     TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The board lists an org's items newest-first.
CREATE INDEX IF NOT EXISTS idx_track_items_org ON track_items (org_id, created_at DESC);
-- One track item per origin (a meeting action links to exactly one item — idempotent tracking).
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_items_source_ref
  ON track_items (org_id, source_ref) WHERE source_ref IS NOT NULL;
