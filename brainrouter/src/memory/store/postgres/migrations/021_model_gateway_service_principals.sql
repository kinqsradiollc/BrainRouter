-- 021_model_gateway_service_principals.sql — revocable, org-scoped identities
-- for internal callers of the hosted model data plane. Signed JWTs contain no
-- reusable secret beyond the bearer itself; persistence supplies current
-- activation and scope checks on every request.

CREATE TABLE IF NOT EXISTS model_gateway_service_principals (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  scopes_json  text NOT NULL DEFAULT '["models:invoke"]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_gateway_service_principal_scopes_array
    CHECK (jsonb_typeof(scopes_json::jsonb) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_model_gateway_service_principals_org
  ON model_gateway_service_principals(org_id, active, id);

-- Manual rollback (before newer migrations depend on this table):
--   DROP TABLE IF EXISTS model_gateway_service_principals;
