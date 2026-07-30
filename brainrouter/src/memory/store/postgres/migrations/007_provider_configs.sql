-- 007_provider_configs.sql — ADR-010 P2: DB-backed AI provider config (no .env).
--
-- One row per (org, kind, provider). `kind` is the backend service role
-- (llm/embedding/reranker/judge). The API key is stored SEALED (secretBox /
-- AES-256-GCM) in api_key_ciphertext — never plaintext at rest. Schema mirrors
-- the desktop/CLI LLMConfig/ProviderDefinition shape so the setup is identical.

CREATE TABLE IF NOT EXISTS provider_configs (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  kind               text NOT NULL,                 -- llm | embedding | reranker | judge
  provider_id        text NOT NULL DEFAULT '',      -- mirrors ProviderDefinition.id
  label              text NOT NULL DEFAULT '',
  base_url           text NOT NULL DEFAULT '',      -- desktop `endpoint`
  api_key_ciphertext text NOT NULL DEFAULT '',      -- secretBox-sealed; '' = no key
  model              text NOT NULL DEFAULT '',
  models_json        text NOT NULL DEFAULT '[]',    -- LLMConfig.models
  wire_format        text NOT NULL DEFAULT '',      -- requestFormat
  reasoning_effort   text NOT NULL DEFAULT '',
  extra_json         text NOT NULL DEFAULT '{}',    -- per-provider knobs
  enabled            boolean NOT NULL DEFAULT true,
  is_default         boolean NOT NULL DEFAULT false,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_configs_org_kind ON provider_configs(org_id, kind);

-- At most one DEFAULT provider per (org, kind); the write path clears the others.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_default
  ON provider_configs(org_id, kind) WHERE is_default;
