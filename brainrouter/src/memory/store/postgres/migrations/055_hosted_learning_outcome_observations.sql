-- ADR-032 D6 — confirmations and contradictions count distinct logical
-- sessions, not reflection jobs.  A session may produce multiple checkpoints,
-- resume after a process restart, or be re-admitted after the cost budget's
-- idle reset; none of those are a second outcome observation.

CREATE TABLE IF NOT EXISTS hosted_learning_outcome_observations (
  org_id            text NOT NULL,
  user_id           text NOT NULL,
  item_id           text NOT NULL,
  session_identity  text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('confirmed', 'contradicted')),
  first_job_id      text NOT NULL,
  last_job_id       text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, user_id, item_id, session_identity),
  CHECK (session_identity ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_hosted_learning_outcome_item
  ON hosted_learning_outcome_observations (org_id, user_id, item_id);
