-- 025_meetings_sharing (ADR-018) — Meetings capability.
-- Additive. `cognitive_records.visibility` is a plain text column (008_memory_org_scope.sql:11,
-- no CHECK), so the new 'team'/'public' scope values need no constraint change — only a team_id.

-- Team-scoped memory recall: which team a 'team'-visibility record belongs to.
ALTER TABLE cognitive_records ADD COLUMN IF NOT EXISTS team_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cognitive_records_team
  ON cognitive_records (team_id) WHERE team_id IS NOT NULL;

-- Meeting index — display data for list/detail, plus links to the recallable memory
-- records (summary CognitiveRecord + transcript SourceDocument) it mirrors into memory.
CREATE TABLE IF NOT EXISTS meetings (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  meeting_date          TEXT,
  status                TEXT NOT NULL DEFAULT 'recorded',
  duration_min          INTEGER,
  word_count            INTEGER,
  attendees_json        TEXT NOT NULL DEFAULT '[]',
  transcript_text       TEXT NOT NULL DEFAULT '',
  summary_markdown      TEXT NOT NULL DEFAULT '',
  action_items_json     TEXT NOT NULL DEFAULT '[]',
  summary_record_id     TEXT,
  transcript_source_id  TEXT,
  scope                 TEXT NOT NULL DEFAULT 'private',
  team_id               TEXT,
  model_label           TEXT,
  model_effort          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings (org_id, user_id, created_at DESC);

-- Revocable public share tokens (the ONLY anonymous read path — redacted summary only).
CREATE TABLE IF NOT EXISTS meeting_shares (
  token       TEXT PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_meeting_shares_meeting ON meeting_shares (meeting_id);
