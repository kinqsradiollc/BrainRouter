-- 009_integration_configs.sql — ADR-010 P6/ADR-009: org-scoped integration
-- config (the org's own GitHub App bot). Mirrors provider_configs: org-scoped,
-- admin-managed, with the sensitive parts (App private key + webhook secret)
-- stored SEALED (secretBox) in secret_ciphertext. Non-secret fields (appId,
-- installationId, apiBase) live in config_json. Per the "both" decision, each
-- local user still runs their own App (cli.triggers.githubApp); this is the
-- ORG backend's App for org repos.

CREATE TABLE IF NOT EXISTS integration_configs (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  kind              text NOT NULL,                -- e.g. 'github_app'
  enabled           boolean NOT NULL DEFAULT true,
  config_json       text NOT NULL DEFAULT '{}',   -- non-secret (appId, installationId, apiBase, …)
  secret_ciphertext text NOT NULL DEFAULT '',     -- secretBox-sealed JSON (privateKey, webhookSecret)
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_org_kind ON integration_configs(org_id, kind);
