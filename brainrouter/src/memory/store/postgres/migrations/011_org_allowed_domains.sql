-- 011_org_allowed_domains (ADR-014 Phase B) — enterprise email-domain allowlist
-- on the tenancy unit (org = "team"). When non-empty, only people whose email
-- domain is in the list may be invited/added to the team (e.g. only @acme.com).
-- Empty (the default) = no restriction. Gated by the `domainAllowlist` plan
-- feature (enterprise / self-hosted enterprise).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS allowed_domains text[] NOT NULL DEFAULT '{}';
