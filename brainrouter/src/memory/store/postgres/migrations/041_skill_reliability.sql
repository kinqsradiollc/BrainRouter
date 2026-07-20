-- 041_skill_reliability — ADR-020 D1: skill reliability lifecycle.
-- A registered skill (skill_extraction_hints) previously carried no runtime reputation:
-- once it existed we never learned whether it actually worked, so reliable skills could
-- not be ranked above flaky ones and a repeatedly-failing skill could not be demoted.
-- Add usage/success counters + a demotion flag so recall can weight and hide skills by
-- their proven reliability. Additive; existing columns unchanged; safe to re-run.
ALTER TABLE skill_extraction_hints ADD COLUMN IF NOT EXISTS usage_count   integer NOT NULL DEFAULT 0;
ALTER TABLE skill_extraction_hints ADD COLUMN IF NOT EXISTS success_count integer NOT NULL DEFAULT 0;
ALTER TABLE skill_extraction_hints ADD COLUMN IF NOT EXISTS last_used_at  text    NOT NULL DEFAULT '';
ALTER TABLE skill_extraction_hints ADD COLUMN IF NOT EXISTS demoted       boolean NOT NULL DEFAULT false;
