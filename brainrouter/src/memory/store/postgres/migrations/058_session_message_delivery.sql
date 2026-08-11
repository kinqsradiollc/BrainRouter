-- 058 / ADR-034 — tenant-safe, durable active-session message delivery.

-- Active sessions are authorization anchors, so their identity must include the
-- server-pinned organization as well as the user and session key. An empty
-- organization id is the existing personal tenant.
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS org_id text;
UPDATE active_sessions SET org_id = '' WHERE org_id IS NULL;
ALTER TABLE active_sessions ALTER COLUMN org_id SET DEFAULT '';
ALTER TABLE active_sessions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_pkey;
ALTER TABLE active_sessions
  ADD CONSTRAINT active_sessions_pkey PRIMARY KEY (org_id, user_id, session_key);
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS claim_expires_at text;
UPDATE active_sessions
   SET claim_token = COALESCE(
         claim_token,
         'legacy:' || md5(org_id || ':' || user_id || ':' || session_key)
       ),
       claim_expires_at = COALESCE(
         claim_expires_at,
         (last_heartbeat_at::timestamptz + interval '2 minutes')::text
       );
ALTER TABLE active_sessions ALTER COLUMN claim_token SET NOT NULL;
ALTER TABLE active_sessions ALTER COLUMN claim_expires_at SET NOT NULL;
DROP INDEX IF EXISTS idx_active_sessions_user_heartbeat;
CREATE INDEX idx_active_sessions_tenant_heartbeat
  ON active_sessions (org_id, user_id, last_heartbeat_at DESC, session_key);

-- Each fanout target has an independent durable receipt. Pending and held rows
-- expire after 24 hours; terminal receipts remain sender-visible for seven days
-- unless the sender acknowledges them first.
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS updated_at text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS expires_at text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS terminal_at text;
ALTER TABLE session_inbox ADD COLUMN IF NOT EXISTS sender_acknowledged_at text;

UPDATE session_inbox
   SET org_id = COALESCE(org_id, ''),
       message_id = COALESCE(message_id, id),
       status = COALESCE(status, CASE WHEN delivered_at IS NULL THEN 'pending' ELSE 'applied' END),
       updated_at = COALESCE(updated_at, delivered_at, created_at),
       expires_at = COALESCE(
         expires_at,
         (created_at::timestamptz + interval '24 hours')::text
       ),
       terminal_at = COALESCE(
         terminal_at,
         CASE WHEN delivered_at IS NOT NULL THEN delivered_at ELSE NULL END
       );

ALTER TABLE session_inbox ALTER COLUMN org_id SET DEFAULT '';
ALTER TABLE session_inbox ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE session_inbox ALTER COLUMN message_id SET NOT NULL;
ALTER TABLE session_inbox ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE session_inbox ALTER COLUMN status SET NOT NULL;
ALTER TABLE session_inbox ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE session_inbox ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE session_inbox DROP CONSTRAINT IF EXISTS session_inbox_status_check;
ALTER TABLE session_inbox
  ADD CONSTRAINT session_inbox_status_check
  CHECK (status IN ('pending', 'held', 'applied', 'rejected', 'declined', 'expired', 'queue_full'));

DROP INDEX IF EXISTS idx_session_inbox_recipient;
DROP INDEX IF EXISTS idx_session_inbox_delivered;
CREATE UNIQUE INDEX session_inbox_sender_message_recipient_key
  ON session_inbox (org_id, user_id, from_session_key, message_id, to_session_key);
CREATE INDEX idx_session_inbox_tenant_recipient_status
  ON session_inbox (org_id, user_id, to_session_key, status, created_at, id);
CREATE INDEX idx_session_inbox_sender_receipts
  ON session_inbox (org_id, user_id, from_session_key, message_id, created_at, id);
CREATE INDEX idx_session_inbox_expiry
  ON session_inbox (status, expires_at)
  WHERE status IN ('pending', 'held');
CREATE INDEX idx_session_inbox_terminal_retention
  ON session_inbox (terminal_at)
  WHERE terminal_at IS NOT NULL;

-- The logical send is separate from delivery rows so retries of a broadcast
-- remain idempotent even when the active-recipient set changes. The content hash
-- prevents a sender from reusing an idempotency key for different content.
CREATE TABLE session_message_sends (
  org_id           text NOT NULL DEFAULT '',
  user_id          text NOT NULL,
  from_session_key text NOT NULL,
  message_id       text NOT NULL,
  to_address       text NOT NULL,
  kind             text NOT NULL,
  payload_hash     text NOT NULL,
  created_at       text NOT NULL,
  PRIMARY KEY (org_id, user_id, from_session_key, message_id)
);
CREATE INDEX idx_session_message_sends_created
  ON session_message_sends (created_at);
