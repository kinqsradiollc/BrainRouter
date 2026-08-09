-- 056 — allow the `cleanup` assurance stage the code has always written.
--
-- `ASSURANCE_STAGE_NAMES` (packages/types/src/review/run.ts) has eleven stages;
-- migration 046 wrote a CHECK naming ten. The missing one is `cleanup`, and it
-- is not an edge case: `repository-context/session.ts` runs it at the END of
-- every review. So every review reached its final stage, tried to insert a row
-- the constraint refused, and died there.
--
-- The damage was not the failed insert, it was what the failure left behind. A
-- run that dies mid-stage keeps that stage `running`, `terminalStage()` reads a
-- `running` receipt as "not finished — retry it", the retry re-runs the SAME
-- attempt number, and `upsertAssuranceStage` refuses a new receipt id for an
-- existing attempt ("A stage attempt cannot change its receipt id."). The run
-- is then permanently unretryable. That is how one missing enum value stopped
-- PR review entirely and left deep review with no completed index to preflight
-- against.
--
-- Postgres cannot extend a CHECK in place, so the constraint is dropped and
-- recreated from the full list. `NOT VALID` is deliberately NOT used: existing
-- rows all hold values from the old, narrower list, so they satisfy the new one
-- by construction and a validating scan is cheap and honest here.
ALTER TABLE repository_assurance_stages
  DROP CONSTRAINT IF EXISTS repository_assurance_stages_stage_check;

ALTER TABLE repository_assurance_stages
  ADD CONSTRAINT repository_assurance_stages_stage_check
    CHECK (stage IN (
      'authorize',
      'checkout_inventory',
      'index',
      'deterministic_analysis',
      'coverage_risk_map',
      'packet_assembly',
      'candidate_discovery',
      'candidate_verification',
      'lifecycle_gate',
      'publication',
      'cleanup'
    ));

-- Manual rollback (only with review workers stopped, and only after deleting
-- any `cleanup` rows, which the narrower constraint would reject):
--   DELETE FROM repository_assurance_stages WHERE stage = 'cleanup';
--   ALTER TABLE repository_assurance_stages
--     DROP CONSTRAINT repository_assurance_stages_stage_check;
--   ALTER TABLE repository_assurance_stages
--     ADD CONSTRAINT repository_assurance_stages_stage_check
--       CHECK (stage IN ('authorize','checkout_inventory','index',
--         'deterministic_analysis','coverage_risk_map','packet_assembly',
--         'candidate_discovery','candidate_verification','lifecycle_gate',
--         'publication'));
