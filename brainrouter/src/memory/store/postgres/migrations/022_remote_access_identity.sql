-- 022_remote_access_identity.sql — tenant-scoped identities and authorization
-- state for account-based remote desktop access.
--
-- Device identity is the stable installation id + enrolled public key. Active
-- BrainRouter/workspace session keys are deliberately absent. Refresh tokens
-- are persisted only as domain-separated SHA-256 hashes, one row per rotation,
-- so reuse can revoke an entire durable family. Audit is a fixed set of metadata
-- columns: no arbitrary JSON, terminal data, payloads, or reusable credentials.

CREATE TABLE IF NOT EXISTS remote_devices (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id                text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  installation_id        text NOT NULL,
  kind                   text NOT NULL,
  display_name           text NOT NULL DEFAULT '',
  public_key             text NOT NULL,
  public_key_fingerprint text NOT NULL,
  key_algorithm          text NOT NULL DEFAULT 'ed25519',
  status                 text NOT NULL DEFAULT 'active',
  enrolled_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, user_id),
  UNIQUE (org_id, user_id, installation_id),
  UNIQUE (org_id, user_id, public_key_fingerprint),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT remote_devices_kind CHECK (kind IN ('desktop', 'mobile')),
  CONSTRAINT remote_devices_status CHECK (status IN ('active', 'disabled', 'revoked')),
  CONSTRAINT remote_devices_key_algorithm CHECK (key_algorithm = 'ed25519'),
  CONSTRAINT remote_devices_installation_id_length CHECK (length(installation_id) BETWEEN 8 AND 256),
  CONSTRAINT remote_devices_public_key_length CHECK (length(public_key) BETWEEN 32 AND 16384),
  CONSTRAINT remote_devices_fingerprint CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT remote_devices_revocation_state CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_devices_owner_kind
  ON remote_devices(org_id, user_id, kind, status, id);

CREATE TABLE IF NOT EXISTS auth_device_sessions (
  id                       text PRIMARY KEY,
  family_id                text NOT NULL,
  org_id                   text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id                  text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id                text NOT NULL,
  token_hash               text NOT NULL UNIQUE,
  generation               integer NOT NULL DEFAULT 0,
  parent_session_id        text,
  replaced_by_session_id   text,
  expires_at               timestamptz NOT NULL,
  rotated_at               timestamptz,
  reuse_detected_at        timestamptz,
  revoked_at               timestamptz,
  revocation_reason        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, user_id),
  UNIQUE (org_id, user_id, family_id, generation),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_session_id, org_id, user_id)
    REFERENCES auth_device_sessions(id, org_id, user_id),
  FOREIGN KEY (replaced_by_session_id, org_id, user_id)
    REFERENCES auth_device_sessions(id, org_id, user_id),
  CONSTRAINT auth_device_sessions_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_device_sessions_generation CHECK (generation >= 0),
  CONSTRAINT auth_device_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT auth_device_sessions_rotation CHECK (
    replaced_by_session_id IS NULL OR rotated_at IS NOT NULL
  ),
  CONSTRAINT auth_device_sessions_reuse_revokes CHECK (
    reuse_detected_at IS NULL OR revoked_at IS NOT NULL
  ),
  CONSTRAINT auth_device_sessions_revocation_reason CHECK (
    revoked_at IS NULL OR length(COALESCE(revocation_reason, '')) BETWEEN 1 AND 120
  )
);

CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_family
  ON auth_device_sessions(org_id, user_id, family_id, generation DESC);

CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_device_active
  ON auth_device_sessions(org_id, user_id, device_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS remote_access_grants (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id                text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  desktop_device_id      text NOT NULL,
  mobile_device_id       text NOT NULL,
  scopes_json            text NOT NULL DEFAULT '["monitor"]',
  approval_status        text NOT NULL DEFAULT 'pending',
  decided_at             timestamptz,
  decided_by_device_id   text,
  expires_at             timestamptz NOT NULL,
  revoked_at             timestamptz,
  revocation_reason      text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, user_id),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (desktop_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (mobile_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT remote_access_grants_distinct_devices CHECK (desktop_device_id <> mobile_device_id),
  CONSTRAINT remote_access_grants_scopes_array CHECK (
    jsonb_typeof(scopes_json::jsonb) = 'array'
    AND jsonb_array_length(scopes_json::jsonb) > 0
    AND scopes_json::jsonb <@ '["monitor", "control", "approve"]'::jsonb
  ),
  CONSTRAINT remote_access_grants_approval_status CHECK (
    approval_status IN ('pending', 'approved', 'denied')
  ),
  CONSTRAINT remote_access_grants_decision_state CHECK (
    (approval_status = 'pending' AND decided_at IS NULL AND decided_by_device_id IS NULL)
    OR (approval_status IN ('approved', 'denied') AND decided_at IS NOT NULL AND decided_by_device_id IS NOT NULL)
  ),
  CONSTRAINT remote_access_grants_expiry CHECK (expires_at > created_at),
  CONSTRAINT remote_access_grants_revocation_reason CHECK (
    revoked_at IS NULL OR length(COALESCE(revocation_reason, '')) BETWEEN 1 AND 120
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_access_grants_owner
  ON remote_access_grants(org_id, user_id, approval_status, expires_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_remote_access_grants_desktop
  ON remote_access_grants(org_id, user_id, desktop_device_id, revoked_at, expires_at DESC);

-- Fixed metadata columns only. Do not add a generic metadata/content JSON column:
-- the relay broker and audit store must never receive terminal text, RPC payloads,
-- refresh tokens, access tokens, passwords, or other reusable credentials.
CREATE TABLE IF NOT EXISTS remote_access_audit (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id              text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  event_type           text NOT NULL,
  actor_device_id      text,
  target_device_id     text,
  grant_id             text,
  session_family_id    text,
  scopes_json          text NOT NULL DEFAULT '[]',
  reason_code          text,
  request_id           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id),
  FOREIGN KEY (target_device_id, org_id, user_id)
    REFERENCES remote_devices(id, org_id, user_id),
  FOREIGN KEY (grant_id, org_id, user_id)
    REFERENCES remote_access_grants(id, org_id, user_id),
  CONSTRAINT remote_access_audit_event CHECK (event_type IN (
    'device_enrolled', 'device_disabled', 'device_revoked',
    'session_created', 'session_rotated', 'session_reuse_detected', 'session_revoked',
    'grant_requested', 'grant_approved', 'grant_denied', 'grant_revoked',
    'connection_opened', 'connection_closed', 'scope_changed'
  )),
  CONSTRAINT remote_access_audit_scopes CHECK (
    jsonb_typeof(scopes_json::jsonb) = 'array'
    AND scopes_json::jsonb <@ '["monitor", "control", "approve"]'::jsonb
  ),
  CONSTRAINT remote_access_audit_reason_length CHECK (
    reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 120
  ),
  CONSTRAINT remote_access_audit_request_length CHECK (
    request_id IS NULL OR length(request_id) BETWEEN 1 AND 160
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_access_audit_owner_created
  ON remote_access_audit(org_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_remote_access_audit_grant
  ON remote_access_audit(org_id, user_id, grant_id, created_at DESC);

-- Manual rollback (before newer migrations depend on these tables):
--   DROP TABLE IF EXISTS remote_access_audit;
--   DROP TABLE IF EXISTS remote_access_grants;
--   DROP TABLE IF EXISTS auth_device_sessions;
--   DROP TABLE IF EXISTS remote_devices;
