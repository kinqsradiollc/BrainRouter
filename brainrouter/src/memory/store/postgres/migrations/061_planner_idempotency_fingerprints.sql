-- ADR-038 — idempotency keys identify one exact Planner operation.
-- Existing receipts predate fingerprints and remain nullable for compatibility;
-- every newly recorded receipt stores the canonical operation digest.
ALTER TABLE planner_applied_operations
  ADD COLUMN IF NOT EXISTS entity text,
  ADD COLUMN IF NOT EXISTS operation_kind text,
  ADD COLUMN IF NOT EXISTS operation_fingerprint text;

ALTER TABLE planner_applied_operations
  DROP CONSTRAINT IF EXISTS planner_applied_operations_entity_check;
ALTER TABLE planner_applied_operations
  ADD CONSTRAINT planner_applied_operations_entity_check
  CHECK (entity IS NULL OR entity IN ('item', 'block'));

CREATE INDEX IF NOT EXISTS planner_applied_operations_target_idx
  ON planner_applied_operations (org_id, user_id, item_id);
