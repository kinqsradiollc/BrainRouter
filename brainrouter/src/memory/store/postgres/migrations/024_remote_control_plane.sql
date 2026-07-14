-- 024_remote_control_plane.sql — one-time enrollment challenges and relay tickets.
--
-- Both credentials are persisted as domain-separated SHA-256 hashes only. Relay
-- tickets are tenant, device, grant, session-family, audience, and scope bound;
-- PostgreSQL provides the shared atomic consume/revoke boundary used by every
-- API/relay instance. Revocations are also published on the metadata-only
-- `brainrouter_remote_revocations` NOTIFY channel by the query layer.

CREATE TABLE IF NOT EXISTS remote_enrollment_challenges (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id                text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  installation_id        text NOT NULL,
  kind                   text NOT NULL,
  display_name           text NOT NULL DEFAULT '',
  public_key             text NOT NULL,
  public_key_fingerprint text NOT NULL,
  challenge_hash         text NOT NULL UNIQUE,
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz,
  created_at             timestamptz NOT NULL,
  UNIQUE (id, org_id, user_id),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT remote_enrollment_challenges_kind CHECK (kind IN ('desktop', 'mobile')),
  CONSTRAINT remote_enrollment_challenges_installation CHECK (length(installation_id) BETWEEN 8 AND 256),
  CONSTRAINT remote_enrollment_challenges_public_key CHECK (length(public_key) BETWEEN 32 AND 16384),
  CONSTRAINT remote_enrollment_challenges_fingerprint CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT remote_enrollment_challenges_hash CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT remote_enrollment_challenges_expiry CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT remote_enrollment_challenges_consumed CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_enrollment_challenges_active
  ON remote_enrollment_challenges(org_id, user_id, expires_at, id)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS remote_relay_tickets (
  id                     text PRIMARY KEY,
  token_hash             text NOT NULL UNIQUE,
  org_id                 text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id                text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  presenting_device_id   text NOT NULL,
  peer_device_id         text NOT NULL,
  grant_id               text NOT NULL,
  session_family_id      text NOT NULL,
  audience               text NOT NULL DEFAULT 'remote-relay',
  scopes_json            text NOT NULL,
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz,
  revoked_at             timestamptz,
  revocation_reason      text,
  created_at             timestamptz NOT NULL,
  UNIQUE (id, org_id, user_id),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (presenting_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id),
  FOREIGN KEY (peer_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id),
  FOREIGN KEY (grant_id, org_id, user_id)
    REFERENCES remote_access_grants(id, org_id, user_id),
  CONSTRAINT remote_relay_tickets_distinct_devices CHECK (presenting_device_id <> peer_device_id),
  CONSTRAINT remote_relay_tickets_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT remote_relay_tickets_audience CHECK (audience = 'remote-relay'),
  CONSTRAINT remote_relay_tickets_scopes CHECK (
    jsonb_typeof(scopes_json::jsonb) = 'array'
    AND jsonb_array_length(scopes_json::jsonb) > 0
    AND scopes_json::jsonb <@ '["monitor", "control", "approve"]'::jsonb
  ),
  CONSTRAINT remote_relay_tickets_expiry CHECK (
    expires_at >= created_at + interval '30 seconds'
    AND expires_at <= created_at + interval '60 seconds'
  ),
  CONSTRAINT remote_relay_tickets_consumed CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT remote_relay_tickets_revocation CHECK (
    revoked_at IS NULL
    OR (
      revoked_at >= created_at
      AND length(COALESCE(revocation_reason, '')) BETWEEN 1 AND 120
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_relay_tickets_owner_active
  ON remote_relay_tickets(org_id, user_id, expires_at, id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_remote_relay_tickets_grant
  ON remote_relay_tickets(org_id, user_id, grant_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_remote_relay_tickets_family
  ON remote_relay_tickets(org_id, user_id, session_family_id, expires_at DESC);

-- Manual rollback (before newer migrations depend on these tables):
--   DROP TABLE IF EXISTS remote_relay_tickets;
--   DROP TABLE IF EXISTS remote_enrollment_challenges;
