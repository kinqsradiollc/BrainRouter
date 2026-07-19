-- Durable, org-scoped PR review findings. memory_jobs remains the immutable run
-- ledger; these projections track one finding across commits and record every
-- lifecycle transition without duplicating the issue on each review.

CREATE TABLE IF NOT EXISTS review_findings (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  forge                 text NOT NULL DEFAULT 'github',
  repository            text NOT NULL,
  pr_number              integer NOT NULL,
  lens                   text NOT NULL,
  fingerprint            text NOT NULL,
  status                 text NOT NULL DEFAULT 'open',
  severity               text NOT NULL,
  title                  text NOT NULL,
  file_path              text NOT NULL,
  line_start             integer,
  line_end               integer,
  cwe                     text,
  pre_existing           boolean NOT NULL DEFAULT false,
  suggestable            boolean NOT NULL DEFAULT false,
  first_seen_review_id   text NOT NULL,
  last_seen_review_id    text NOT NULL,
  first_seen_sha         text,
  last_seen_sha          text,
  fixed_review_id        text,
  fixed_sha              text,
  resolved_by_login      text,
  first_seen_at          text NOT NULL,
  last_seen_at           text NOT NULL,
  fixed_at               text,
  updated_at             text NOT NULL,
  CONSTRAINT review_findings_status_check
    CHECK (status IN ('open', 'in progress', 'snoozed', 'fixed', 'ignored')),
  CONSTRAINT review_findings_identity_unique
    UNIQUE (org_id, forge, repository, pr_number, lens, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_review_findings_org_status_updated
  ON review_findings (org_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_findings_pr_lens
  ON review_findings (org_id, forge, repository, pr_number, lens, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_findings_org_first_seen
  ON review_findings (org_id, first_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_findings_org_fixed
  ON review_findings (org_id, fixed_at DESC, id DESC)
  WHERE fixed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_finding_events (
  id                text PRIMARY KEY,
  finding_id        text NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
  org_id            text NOT NULL,
  forge             text NOT NULL,
  repository        text NOT NULL,
  pr_number         integer NOT NULL,
  lens              text NOT NULL,
  event_type        text NOT NULL,
  review_id         text NOT NULL,
  head_sha          text,
  actor_login       text,
  occurred_at       text NOT NULL,
  CONSTRAINT review_finding_events_type_check
    CHECK (event_type IN ('discovered', 'observed', 'fixed', 'reopened')),
  CONSTRAINT review_finding_events_idempotent_unique
    UNIQUE (finding_id, review_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_review_finding_events_org_time
  ON review_finding_events (org_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_finding_events_finding_time
  ON review_finding_events (finding_id, occurred_at ASC, id ASC);

-- Contributor identities are intentionally limited to forge login/display name;
-- commit email addresses are never persisted. A PR author may have zero commits.
CREATE TABLE IF NOT EXISTS review_pr_contributors (
  org_id             text NOT NULL,
  forge              text NOT NULL,
  repository         text NOT NULL,
  pr_number          integer NOT NULL,
  login              text NOT NULL,
  display_name       text,
  avatar_url         text,
  is_author          boolean NOT NULL DEFAULT false,
  commit_count       integer NOT NULL DEFAULT 0,
  latest_head_sha    text,
  first_seen_at      text NOT NULL,
  last_seen_at       text NOT NULL,
  PRIMARY KEY (org_id, forge, repository, pr_number, login)
);

CREATE INDEX IF NOT EXISTS idx_review_pr_contributors_org_activity
  ON review_pr_contributors (org_id, last_seen_at DESC, repository, pr_number);
CREATE INDEX IF NOT EXISTS idx_review_pr_contributors_org_login
  ON review_pr_contributors (org_id, login, last_seen_at DESC);

-- A single chronological cursor makes the historical memory_jobs projection
-- restartable. Reconciliation itself is also idempotent through event uniques.
CREATE TABLE IF NOT EXISTS review_lifecycle_backfill (
  scope             text PRIMARY KEY,
  last_created_at   text,
  last_job_id       text,
  completed_at      text,
  updated_at        text NOT NULL
);

-- Manual rollback (only after stopping workers and before newer migrations rely
-- on these projections):
-- DROP TABLE review_lifecycle_backfill;
-- DROP TABLE review_pr_contributors;
-- DROP TABLE review_finding_events;
-- DROP TABLE review_findings;
