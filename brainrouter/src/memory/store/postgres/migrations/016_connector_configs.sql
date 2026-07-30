-- 016_connector_configs.sql — ADR-016 C2: move connectors off desktop-local files
-- into the backend, PER-USER, with the OAuth/token credential SEALED (secretBox).
--
-- Two distinct secrets, two scopes (mirrors the App-key vs. installation split):
--   • connector_configs.credential_ciphertext — the per-USER access/refresh token.
--   • oauth_app_configs.client_secret_ciphertext — the per-ORG OAuth *app* secret,
--     operator-set once, used by the broker to run the OAuth dance for its users.

CREATE TABLE IF NOT EXISTS connector_configs (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL,
  org_id                text,                              -- null = personal; set = team-shared
  source                text NOT NULL,                     -- github, gitlab, slack, …
  name                  text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'connected', -- connected | error | disconnected
  enabled               boolean NOT NULL DEFAULT true,
  visibility            text NOT NULL DEFAULT 'private',   -- 'private' | 'org'
  config_json           text NOT NULL DEFAULT '{}',        -- non-secret (repos, channels, scope, baseUrl)
  credential_ciphertext text NOT NULL DEFAULT '',          -- sealed { accessToken, refreshToken?, expiresAt? }
  checkpoint_json       text NOT NULL DEFAULT '{}',        -- incremental-sync high-watermark
  last_run_at           timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_connector_user ON connector_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_connector_user_source ON connector_configs(user_id, source);
CREATE INDEX IF NOT EXISTS idx_connector_org ON connector_configs(org_id) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_app_configs (
  id                       text PRIMARY KEY,
  org_id                   text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  source                   text NOT NULL,
  client_id                text NOT NULL,
  client_secret_ciphertext text NOT NULL DEFAULT '',
  scopes                   text NOT NULL DEFAULT '',       -- space-separated override (blank = provider default)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_app_org_source ON oauth_app_configs(org_id, source);
