-- ADR-032 D5/Q1 — durable admission for hosted learning reflection.
--
-- The model call runs through memory_jobs, but queue concurrency alone cannot
-- bound how many calls one chat session or tenant buys. These small operational
-- ledgers are not a second learned-state store: learned facts remain cognitive
-- records; this only arbitrates cost before a job is inserted.

CREATE TABLE IF NOT EXISTS hosted_learning_session_budgets (
  org_id              text NOT NULL,
  user_id             text NOT NULL,
  session_key_hash    text NOT NULL,
  spent               integer NOT NULL DEFAULT 0 CHECK (spent >= 0),
  last_admitted_at    timestamptz,
  last_activity_at    timestamptz NOT NULL,
  last_request_key    text,
  last_job_id         text,
  PRIMARY KEY (org_id, user_id, session_key_hash)
);

CREATE TABLE IF NOT EXISTS hosted_learning_tenant_budgets (
  org_id       text NOT NULL,
  user_id      text NOT NULL,
  budget_day   date NOT NULL,
  spent        integer NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (org_id, user_id, budget_day)
);

CREATE INDEX IF NOT EXISTS idx_hosted_learning_session_activity
  ON hosted_learning_session_budgets (last_activity_at);

-- D6 retirement is deliberately bounded per checkpoint. Persist the last
-- stable record key per tenant so a large learned set rotates across passes
-- instead of repeatedly reconsidering only the newest rows.
CREATE TABLE IF NOT EXISTS hosted_learning_retirement_cursors (
  org_id             text NOT NULL,
  user_id            text NOT NULL,
  last_created_time  text,
  last_record_id     text,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (org_id, user_id),
  CHECK ((last_created_time IS NULL) = (last_record_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_cognitive_hosted_learned_retirement
  ON cognitive_records (user_id, org_id, created_time, record_id)
  WHERE type = 'lesson';
