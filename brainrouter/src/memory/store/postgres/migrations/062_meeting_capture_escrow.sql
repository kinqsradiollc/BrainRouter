-- ADR-035 D11 — in the browser, the server is the system of record.
--
-- A browser's capture store can be evicted mid-recording: `navigator.storage.persist()`
-- is granted on engagement heuristics rather than on asking, and eviction is per-origin.
-- So the transcript of an in-progress capture is escrowed here as it settles, and the
-- origin's OPFS/IndexedDB becomes what D11 says it should be — a buffer for the offline
-- case rather than the system of record.
--
-- What is here is TEXT, never audio: the transcript, and enough of the session to turn it
-- into a meeting. Raw microphone audio is a different decision with its own answers to
-- settle, and §6 judges D11 on whether the MEETING survives a refused persistence.
--
-- Partitioned (org_id, user_id, session_id) — the same partition as `meetings` and, per
-- ADR-029 D1, the same one the planner and notes use. A capture is personal: it is only
-- shared once it becomes a meeting and that meeting's scope says so.
CREATE TABLE IF NOT EXISTS meeting_capture_escrow (
  org_id         TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  session_id     TEXT        NOT NULL,
  title          TEXT        NOT NULL DEFAULT '',
  template       TEXT        NOT NULL DEFAULT 'general',
  language       TEXT        NOT NULL DEFAULT '',
  transcript     TEXT        NOT NULL DEFAULT '',
  coverage_ms    BIGINT      NOT NULL DEFAULT 0,
  -- D6 — the window the person set on the host that made the recording, carried so the
  -- server sweeps its copy on the same schedule the device sweeps its audio. A row whose
  -- device never comes back is still deleted.
  retention_days INTEGER     NOT NULL DEFAULT 30,
  started_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, session_id)
);

-- The two reads this table has: "what is open for this person here" (ordered by when the
-- recording started) and the retention sweep's "what has outlived its window".
CREATE INDEX IF NOT EXISTS idx_meeting_capture_escrow_owner
  ON meeting_capture_escrow (org_id, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_capture_escrow_started
  ON meeting_capture_escrow (started_at);
