-- 020_provider_models.sql — org-scoped server-managed model catalog and
-- metadata-only usage accounting.
--
-- provider_configs owns credentials and upstream routing. provider_models owns
-- the public BrainRouter-facing model id and the policy a member is allowed to
-- select. The composite foreign key prevents a model in one organization from
-- pointing at another organization's provider configuration.

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_configs_id_org
  ON provider_configs(id, org_id);

CREATE TABLE IF NOT EXISTS provider_models (
  id                       text PRIMARY KEY,
  org_id                   text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  provider_config_id       text NOT NULL,
  public_model_id          text NOT NULL,
  upstream_model_id        text NOT NULL,
  display_name             text NOT NULL,
  enabled                  boolean NOT NULL DEFAULT true,
  is_default               boolean NOT NULL DEFAULT false,
  sort_order               integer NOT NULL DEFAULT 0,
  allowed_efforts_json     text NOT NULL DEFAULT '[]',
  default_effort           text NOT NULL DEFAULT '',
  effort_wire_map_json     text NOT NULL DEFAULT '{}',
  capabilities_json        text NOT NULL DEFAULT '{}',
  capability_source        text NOT NULL DEFAULT 'manual',
  source_url               text,
  verified_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, public_model_id),
  FOREIGN KEY (provider_config_id, org_id)
    REFERENCES provider_configs(id, org_id) ON DELETE CASCADE,
  CONSTRAINT provider_models_default_enabled CHECK (NOT is_default OR enabled),
  CONSTRAINT provider_models_efforts_array
    CHECK (jsonb_typeof(allowed_efforts_json::jsonb) = 'array'),
  CONSTRAINT provider_models_default_effort_allowed
    CHECK (default_effort = '' OR allowed_efforts_json::jsonb ? default_effort),
  CONSTRAINT provider_models_wire_map_object
    CHECK (jsonb_typeof(effort_wire_map_json::jsonb) = 'object'),
  CONSTRAINT provider_models_capabilities_object
    CHECK (jsonb_typeof(capabilities_json::jsonb) = 'object'),
  CONSTRAINT provider_models_capability_source
    CHECK (capability_source IN ('verified', 'discovered', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_provider_models_org_order
  ON provider_models(org_id, enabled DESC, sort_order, display_name, id);

CREATE INDEX IF NOT EXISTS idx_provider_models_provider
  ON provider_models(provider_config_id, org_id);

-- One public default per organization. The CHECK above guarantees it is enabled.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_models_default
  ON provider_models(org_id) WHERE is_default;

-- This table deliberately records request/accounting metadata only. It never
-- stores prompts, responses, tool payloads, or other user content.
CREATE TABLE IF NOT EXISTS model_usage_events (
  id                    bigserial PRIMARY KEY,
  request_id            text NOT NULL UNIQUE,
  org_id                text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  user_id               text,
  service_principal_id  text,
  public_model_id       text NOT NULL,
  selected_effort       text,
  upstream_route        text,
  latency_ms            integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  http_status           integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  input_tokens          bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens         bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens   bigint CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  total_tokens          bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cost_microusd         bigint CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_usage_actor_present
    CHECK (user_id IS NOT NULL OR service_principal_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_events_org_created
  ON model_usage_events(org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_model_usage_events_org_model_created
  ON model_usage_events(org_id, public_model_id, created_at DESC);

-- Manual rollback (only before any newer migration depends on these objects):
--   DROP TABLE IF EXISTS model_usage_events;
--   DROP TABLE IF EXISTS provider_models;
--   DROP INDEX IF EXISTS uq_provider_configs_id_org;
-- The migration runner is forward-only, so production rollback should restore
-- the preceding application image first and execute the statements explicitly.
