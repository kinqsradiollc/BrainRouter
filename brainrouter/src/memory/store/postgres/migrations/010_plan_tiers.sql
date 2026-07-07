-- 010_plan_tiers (ADR-014) — expand the plan tiers on the tenancy unit (org = "team").
--
-- Pre-ADR-014 the plan enum was {single, team, enterprise} and personal orgs
-- defaulted to 'single'. The model now uses {free, pro, team, enterprise,
-- self_hosted_enterprise}, with 'free' as the solo/local-first default. This
-- backfills legacy 'single' rows to 'free' and shifts the column default.
--
-- The plan column is free-text (no CHECK constraint), so no type change is needed;
-- normalizeOrgPlan() coerces any stray legacy value on read as a belt-and-braces.

UPDATE organizations SET plan = 'free' WHERE plan = 'single';

ALTER TABLE organizations ALTER COLUMN plan SET DEFAULT 'free';
