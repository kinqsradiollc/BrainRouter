-- Exact-revision assurance findings and their independently addressable evidence.
--
-- Findings remain tenant- and run-bound. Evidence is normalized so publication
-- and gate decisions can require concrete current-head records instead of
-- trusting a model-authored assertion embedded in one opaque payload.

CREATE TABLE IF NOT EXISTS repository_assurance_findings (
  org_id                    text NOT NULL,
  id                        text NOT NULL,
  run_id                    text NOT NULL REFERENCES repository_assurance_runs(id) ON DELETE CASCADE,
  fingerprint               text NOT NULL,
  program                   text NOT NULL,
  revision_sha              text NOT NULL,
  state                     text NOT NULL,
  severity                  text NOT NULL,
  confidence                double precision NOT NULL,
  title                     text NOT NULL,
  mechanism                 text NOT NULL,
  location_json             jsonb NOT NULL,
  provenance_json           jsonb NOT NULL,
  coverage_limitations_json jsonb NOT NULL,
  verifier_json             jsonb,
  cwe                       text,
  cve                       text,
  remediation               text,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  PRIMARY KEY (org_id, id),
  CONSTRAINT repository_assurance_findings_run_unique UNIQUE (run_id, id),
  CONSTRAINT repository_assurance_findings_program_check
    CHECK (program IN ('code_review', 'security_review', 'authorized_pentest')),
  CONSTRAINT repository_assurance_findings_state_check
    CHECK (state IN ('candidate', 'hotspot', 'verified', 'disputed', 'insufficient_evidence', 'validated')),
  CONSTRAINT repository_assurance_findings_severity_check
    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  CONSTRAINT repository_assurance_findings_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT repository_assurance_findings_json_check
    CHECK (
      jsonb_typeof(location_json) = 'object'
      AND jsonb_typeof(provenance_json) = 'array'
      AND jsonb_typeof(coverage_limitations_json) = 'array'
      AND (verifier_json IS NULL OR jsonb_typeof(verifier_json) = 'object')
    )
);

CREATE INDEX IF NOT EXISTS idx_repository_assurance_findings_run
  ON repository_assurance_findings (org_id, run_id, severity, state, id);
CREATE INDEX IF NOT EXISTS idx_repository_assurance_findings_lineage
  ON repository_assurance_findings (org_id, fingerprint, program, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS repository_assurance_evidence (
  org_id        text NOT NULL,
  finding_id    text NOT NULL,
  id            text NOT NULL,
  kind          text NOT NULL,
  summary       text NOT NULL,
  revision_sha  text NOT NULL,
  location_json jsonb,
  artifact_ref  text,
  analyzer_id   text,
  model_id      text,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (org_id, finding_id, id),
  CONSTRAINT repository_assurance_evidence_finding_fk
    FOREIGN KEY (org_id, finding_id)
    REFERENCES repository_assurance_findings(org_id, id)
    ON DELETE CASCADE,
  CONSTRAINT repository_assurance_evidence_kind_check
    CHECK (kind IN (
      'source',
      'call_path',
      'reference_path',
      'configuration',
      'dependency',
      'secret_match',
      'test',
      'diagnostic',
      'runtime_observation',
      'authorization',
      'cleanup'
    )),
  CONSTRAINT repository_assurance_evidence_location_check
    CHECK (location_json IS NULL OR jsonb_typeof(location_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_repository_assurance_evidence_finding
  ON repository_assurance_evidence (org_id, finding_id, kind, id);

-- Manual rollback (only after stopping review workers and before newer
-- migrations depend on these records):
-- DROP TABLE repository_assurance_evidence;
-- DROP TABLE repository_assurance_findings;
