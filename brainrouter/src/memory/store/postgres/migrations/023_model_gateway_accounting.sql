-- Shared gateway request accounting. These fixed-shape tables intentionally
-- contain no prompt, response, tool payload, bearer, or provider credential.

CREATE TABLE IF NOT EXISTS model_gateway_rate_windows (
  org_id         text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  scope_type     text NOT NULL,
  subject_id     text NOT NULL,
  window_start   timestamptz NOT NULL,
  request_count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, scope_type, subject_id, window_start),
  CONSTRAINT model_gateway_rate_scope
    CHECK (scope_type IN ('organization', 'user', 'service')),
  CONSTRAINT model_gateway_rate_count CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_model_gateway_rate_windows_expiry
  ON model_gateway_rate_windows(window_start);

CREATE TABLE IF NOT EXISTS model_gateway_concurrency_leases (
  request_id      text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  principal_type  text NOT NULL,
  principal_id    text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_gateway_lease_principal
    CHECK (principal_type IN ('user', 'service')),
  CONSTRAINT model_gateway_lease_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_model_gateway_leases_org_expiry
  ON model_gateway_concurrency_leases(org_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_model_gateway_leases_principal_expiry
  ON model_gateway_concurrency_leases(org_id, principal_type, principal_id, expires_at);

-- Manual rollback (only before newer migrations depend on these objects):
--   DROP TABLE IF EXISTS model_gateway_concurrency_leases;
--   DROP TABLE IF EXISTS model_gateway_rate_windows;
