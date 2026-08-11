-- ADR-038 D4 — time blocks participate in planner sync as their own records.
--
-- Migration 051 gave blocks a server revision but no client mutation stamp.
-- Without the HLC, a stale device that pushed last could move a block backwards.
-- Existing rows are seeded from their durable database update time.

ALTER TABLE planner_blocks
  ADD COLUMN IF NOT EXISTS updated_at_hlc jsonb;

UPDATE planner_blocks
   SET updated_at_hlc = jsonb_build_object(
         'physical', floor(extract(epoch FROM updated_at) * 1000)::bigint,
         'logical', 0,
         'deviceId', 'server-migration'
       )
 WHERE updated_at_hlc IS NULL;

ALTER TABLE planner_blocks
  ALTER COLUMN updated_at_hlc SET DEFAULT jsonb_build_object(
    'physical', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    'logical', 0,
    'deviceId', 'server-compat'
  ),
  ALTER COLUMN updated_at_hlc SET NOT NULL;
