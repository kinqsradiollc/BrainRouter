-- 036_chat_threads — cross-surface chat history server plane.
-- Chat threads used to live ONLY in each client's local storage: the dashboard keeps
-- them in localStorage (chatSessions.ts), and desktop + CLI store them locally too, so a
-- conversation started on one surface is invisible on the others. This gives chat history a
-- shared server home so a later change can repoint the clients to sync. Unlike Track (an
-- org-shared board), a chat thread is PERSONAL: private to its owning user within the org —
-- every query is keyed by BOTH org_id and user_id so no other member can read it. Additive;
-- no existing table changes.
CREATE TABLE IF NOT EXISTS chat_threads (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,                 -- owner (thread is private to this user)
  title       TEXT NOT NULL DEFAULT '',
  model       TEXT,                          -- last model used for the thread (optional)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The sidebar lists a single user's threads within an org, most-recently-touched first.
CREATE INDEX IF NOT EXISTS idx_chat_threads_owner
  ON chat_threads (org_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,              -- 0-based position within the thread
  role        TEXT NOT NULL,                 -- user | assistant | system | tool
  content     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Read a thread's messages in order.
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (thread_id, ordinal);
