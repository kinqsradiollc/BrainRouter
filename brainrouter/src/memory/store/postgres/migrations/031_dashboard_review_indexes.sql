-- Dashboard review projections: accelerate org lists and exact PR activity reads.
-- Values remain in input_json for queue compatibility; expression indexes avoid
-- a broad memory_jobs scan without duplicating tenant metadata.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_review_org_created
  ON memory_jobs (((input_json::jsonb ->> 'orgId')), created_at DESC, id DESC)
  WHERE kind IN ('pr-security-review','pr-code-review','pr-pentest','domain-pentest');

CREATE INDEX IF NOT EXISTS idx_memory_jobs_review_pr_created
  ON memory_jobs (
    ((input_json::jsonb ->> 'orgId')),
    ((input_json::jsonb ->> 'repo')),
    ((input_json::jsonb ->> 'prNumber')),
    kind,
    created_at DESC,
    id DESC
  )
  WHERE kind IN ('pr-security-review','pr-code-review','pr-pentest');
