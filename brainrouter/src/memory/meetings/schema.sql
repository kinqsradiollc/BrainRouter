-- Meetings sharing schema (ADR-018 D8). PROVISIONAL — promote to a numbered migration
-- (e.g. 0NN_meetings_sharing.sql) at integration time, AFTER Codex's server-managed-models
-- migrations claim 020+, to avoid a migration-number collision. Additive + reversible.

-- 1) Extend the memory visibility ladder: "private" | "org"  →  add "team" | "public".
--    The existing CHECK/enum on cognitive_records.visibility must be widened. If visibility
--    is a bare text column, only the app-level union changes (MemoryVisibility in
--    packages/types/src/memory/records.ts) — confirm at integration.
ALTER TABLE cognitive_records
  ADD COLUMN IF NOT EXISTS team_id TEXT;                 -- set only when visibility = 'team'
CREATE INDEX IF NOT EXISTS idx_cognitive_records_team
  ON cognitive_records (team_id) WHERE team_id IS NOT NULL;

-- 2) Revocable public share tokens (the ONLY anonymous read path — summary-only, redacted).
CREATE TABLE IF NOT EXISTS meeting_shares (
  token         TEXT PRIMARY KEY,                        -- random, URL-safe, unguessable
  record_id     TEXT NOT NULL,                           -- the summary CognitiveRecord
  org_id        TEXT NOT NULL,
  created_by    TEXT NOT NULL,                           -- audit: who published (owner)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,                             -- optional expiry
  revoked_at    TIMESTAMPTZ                              -- set on downgrade / manual revoke
);
CREATE INDEX IF NOT EXISTS idx_meeting_shares_record ON meeting_shares (record_id);
-- Active tokens only: revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()).
