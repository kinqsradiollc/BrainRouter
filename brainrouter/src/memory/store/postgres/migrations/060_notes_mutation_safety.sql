-- ADR-038: durable, replay-safe hosted Notes mutations.
--
-- Primitive and high-level receipts share the existing tenant/user partition,
-- but now retain enough evidence to distinguish a replay from key reuse and to
-- return the exact response when the first HTTP response was lost.
ALTER TABLE notes_applied_operations
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS response_json jsonb;

-- The hosted editor emits HLCs on behalf of browser clients.  Keeping the
-- highest clock observed in Postgres makes that clock survive restarts and
-- remain monotonic when requests move between API processes.
CREATE TABLE IF NOT EXISTS notes_host_clocks (
  org_id      text        NOT NULL,
  user_id     text        NOT NULL,
  physical    bigint      NOT NULL,
  logical     bigint      NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, user_id)
);
