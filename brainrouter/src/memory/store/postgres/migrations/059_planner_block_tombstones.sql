-- Item deletion cascades to durable time-block tombstones. Pull includes these
-- rows so an offline or fresh device can remove scheduled blocks deterministically.

ALTER TABLE planner_blocks
  ADD COLUMN IF NOT EXISTS deleted_at_hlc jsonb;

CREATE INDEX IF NOT EXISTS planner_blocks_live_day_idx
  ON planner_blocks (org_id, user_id, scheduled_for, revision)
  WHERE deleted_at_hlc IS NULL;
