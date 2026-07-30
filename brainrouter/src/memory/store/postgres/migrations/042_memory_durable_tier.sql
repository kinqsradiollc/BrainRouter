-- 042_memory_durable_tier — ADR-020 D4: confidence promotion tier.
-- A cognitive memory that reaches high confidence AND enough corroboration
-- (citations) graduates to a DURABLE tier: it is exempt from age-based decay
-- (half_life_days set NULL by the promoter) and preferentially recalled. This
-- flag records that graduation so recall can favour proven knowledge and the
-- consolidation cycle (D2) can find it. Additive; existing columns unchanged.
ALTER TABLE cognitive_records ADD COLUMN IF NOT EXISTS durable boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_cognitive_durable ON cognitive_records(user_id, durable) WHERE durable;
