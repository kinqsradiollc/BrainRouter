-- One row per projected review job is the idempotency boundary, including
-- clean reviews that emit no finding events. This is intentionally separate
-- from 039 because 039 may already be applied during a rolling development
-- upgrade before the projection ledger was introduced.

CREATE TABLE IF NOT EXISTS review_job_projections (
  review_id          text PRIMARY KEY,
  org_id             text NOT NULL,
  forge              text NOT NULL,
  repository         text NOT NULL,
  pr_number          integer NOT NULL,
  lens               text NOT NULL,
  review_created_at  text NOT NULL,
  projected_at       text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_job_projections_scope
  ON review_job_projections (org_id, forge, repository, pr_number, lens, review_created_at DESC, review_id DESC);

-- Manual rollback (only after stopping workers):
-- DROP TABLE review_job_projections;
