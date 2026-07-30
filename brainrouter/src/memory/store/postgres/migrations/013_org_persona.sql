-- 013_org_persona (ADR-014 Phase C) — a Team's consensus persona, distilled from
-- its SHARED (visibility='org') persona/instruction memories. Kept separate from
-- core_identity (the user's personal persona) so the two never overwrite each
-- other; the injected persona is "personal + team overlay". Gated by the plan's
-- `orgPersona` feature.
CREATE TABLE IF NOT EXISTS org_identity (
  org_id                        text PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
  persona_md                    text NOT NULL,
  cognitive_count_at_generation integer DEFAULT 0,
  created_time                  text DEFAULT '',
  updated_time                  text DEFAULT ''
);
