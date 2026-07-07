-- 015_org_audit (ADR-014 Phase F) — a tenancy audit trail (who did what, when) for
-- the admin console: membership changes, plan changes, ownership, project changes.
CREATE TABLE IF NOT EXISTS org_audit_log (
  id         bigserial PRIMARY KEY,
  org_id     text NOT NULL,
  actor_id   text,
  action     text NOT NULL,
  target     text,
  detail     text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_audit_org ON org_audit_log(org_id, id DESC);
