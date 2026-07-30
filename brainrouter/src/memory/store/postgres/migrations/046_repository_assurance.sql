-- Durable repository-assurance receipts.
--
-- memory_jobs remains the immutable queue/execution ledger. These normalized
-- records pin one tenant, repository revision, policy snapshot, source receipt,
-- coverage statement, and ordered stage attempts so incomplete or superseded
-- work cannot be mistaken for a clean review.

CREATE TABLE IF NOT EXISTS repository_assurance_runs (
  id                    text PRIMARY KEY,
  job_id                text NOT NULL UNIQUE REFERENCES memory_jobs(id) ON DELETE RESTRICT,
  org_id                text NOT NULL,
  idempotency_key       text NOT NULL,
  forge                 text NOT NULL,
  repository            text NOT NULL,
  repository_id         text,
  default_branch        text,
  program               text NOT NULL,
  base_sha              text,
  head_sha              text NOT NULL,
  merge_base_sha        text,
  policy_snapshot_id    text NOT NULL,
  policy_hash           text NOT NULL,
  policy_json           jsonb NOT NULL,
  status                text NOT NULL,
  superseded_by_run_id  text REFERENCES repository_assurance_runs(id) ON DELETE RESTRICT,
  stale_reason          text,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  CONSTRAINT repository_assurance_runs_forge_check
    CHECK (forge IN ('github', 'gitlab', 'local')),
  CONSTRAINT repository_assurance_runs_program_check
    CHECK (program IN ('code_review', 'security_review', 'authorized_pentest')),
  CONSTRAINT repository_assurance_runs_status_check
    CHECK (status IN ('queued', 'running', 'partial', 'completed', 'failed', 'canceled', 'superseded', 'stale')),
  CONSTRAINT repository_assurance_runs_status_evidence_check
    CHECK (
      (status = 'superseded' AND superseded_by_run_id IS NOT NULL AND stale_reason IS NULL)
      OR (status = 'stale' AND stale_reason IS NOT NULL AND superseded_by_run_id IS NULL)
      OR (status NOT IN ('superseded', 'stale') AND superseded_by_run_id IS NULL AND stale_reason IS NULL)
    ),
  CONSTRAINT repository_assurance_runs_idempotent_unique
    UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_repository_assurance_runs_scope
  ON repository_assurance_runs (
    org_id,
    forge,
    repository,
    program,
    created_at DESC,
    id DESC
  );
CREATE INDEX IF NOT EXISTS idx_repository_assurance_runs_status
  ON repository_assurance_runs (org_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_repository_assurance_runs_revision
  ON repository_assurance_runs (org_id, forge, repository, head_sha, program);

CREATE TABLE IF NOT EXISTS repository_source_snapshots (
  id                      text PRIMARY KEY,
  run_id                  text NOT NULL UNIQUE REFERENCES repository_assurance_runs(id) ON DELETE CASCADE,
  status                  text NOT NULL,
  base_sha                text,
  head_sha                text NOT NULL,
  merge_base_sha          text,
  checkout_ref            text,
  inventory_ref           text,
  file_count              integer NOT NULL,
  text_file_count         integer NOT NULL,
  indexed_file_count      integer NOT NULL,
  unsupported_file_count  integer NOT NULL,
  byte_count              bigint,
  error_code              text,
  created_at              timestamptz NOT NULL,
  completed_at            timestamptz,
  CONSTRAINT repository_source_snapshots_status_check
    CHECK (status IN ('pending', 'ready', 'partial', 'failed', 'stale')),
  CONSTRAINT repository_source_snapshots_counts_check
    CHECK (
      file_count >= 0
      AND text_file_count >= 0
      AND indexed_file_count >= 0
      AND unsupported_file_count >= 0
      AND (byte_count IS NULL OR byte_count >= 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_repository_source_snapshots_status
  ON repository_source_snapshots (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS repository_assurance_coverage (
  run_id                   text PRIMARY KEY REFERENCES repository_assurance_runs(id) ON DELETE CASCADE,
  status                   text NOT NULL,
  files_total              integer NOT NULL,
  files_eligible           integer NOT NULL,
  files_analyzed           integer NOT NULL,
  changed_files_total      integer NOT NULL,
  changed_files_analyzed   integer NOT NULL,
  analyzers_json           jsonb NOT NULL,
  limitations_json         jsonb NOT NULL,
  calculated_at            timestamptz NOT NULL,
  CONSTRAINT repository_assurance_coverage_status_check
    CHECK (status IN ('complete', 'partial', 'unavailable')),
  CONSTRAINT repository_assurance_coverage_counts_check
    CHECK (
      files_total >= 0
      AND files_eligible >= 0
      AND files_analyzed >= 0
      AND files_analyzed <= files_eligible
      AND changed_files_total >= 0
      AND changed_files_analyzed >= 0
      AND changed_files_analyzed <= changed_files_total
    ),
  CONSTRAINT repository_assurance_coverage_arrays_check
    CHECK (
      jsonb_typeof(analyzers_json) = 'array'
      AND jsonb_typeof(limitations_json) = 'array'
    )
);

CREATE TABLE IF NOT EXISTS repository_assurance_stages (
  id                text PRIMARY KEY,
  run_id            text NOT NULL REFERENCES repository_assurance_runs(id) ON DELETE CASCADE,
  stage             text NOT NULL,
  status            text NOT NULL,
  attempt           integer NOT NULL,
  started_at        timestamptz,
  completed_at      timestamptz,
  duration_ms       integer,
  input_refs_json   jsonb NOT NULL,
  output_refs_json  jsonb NOT NULL,
  limitation_ids_json jsonb NOT NULL,
  error_code        text,
  CONSTRAINT repository_assurance_stages_stage_check
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
      'publication'
    )),
  CONSTRAINT repository_assurance_stages_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'skipped', 'canceled')),
  CONSTRAINT repository_assurance_stages_attempt_check
    CHECK (attempt > 0 AND (duration_ms IS NULL OR duration_ms >= 0)),
  CONSTRAINT repository_assurance_stages_arrays_check
    CHECK (
      jsonb_typeof(input_refs_json) = 'array'
      AND jsonb_typeof(output_refs_json) = 'array'
      AND jsonb_typeof(limitation_ids_json) = 'array'
    ),
  CONSTRAINT repository_assurance_stages_attempt_unique
    UNIQUE (run_id, stage, attempt)
);

CREATE INDEX IF NOT EXISTS idx_repository_assurance_stages_run
  ON repository_assurance_stages (run_id, stage, attempt);

-- Manual rollback (only after stopping review workers and before newer
-- migrations depend on these receipts):
-- DROP TABLE repository_assurance_stages;
-- DROP TABLE repository_assurance_coverage;
-- DROP TABLE repository_source_snapshots;
-- DROP TABLE repository_assurance_runs;
