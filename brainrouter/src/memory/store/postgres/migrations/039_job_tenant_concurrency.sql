-- 039_job_tenant_concurrency — per-tenant fair scheduling for the memory-jobs queue.
-- The runner now drains jobs concurrently under a per-tenant concurrency cap; that
-- cap counts a tenant's `running` jobs, so materialize the tenant (org for reviews,
-- user for maintenance) as a real column instead of re-deriving it from input_json
-- on every claim. Additive + nullable; a NULL tenant is exempt from the per-tenant
-- cap (bounded only by the global ceiling).
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS tenant text;

-- Backfill existing rows best-effort. A subtransaction guards a legacy malformed
-- input_json so a bad row can never fail the migration; new rows get `tenant`
-- populated at insert time in code.
DO $$
BEGIN
  UPDATE memory_jobs
     SET tenant = COALESCE(input_json::jsonb ->> 'orgId', input_json::jsonb ->> 'userId')
   WHERE tenant IS NULL AND input_json IS NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'memory_jobs.tenant backfill skipped (invalid input_json): %', SQLERRM;
END $$;

-- Running-count lookup for the per-tenant cap: only running rows are ever counted.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_tenant_running
  ON memory_jobs (tenant) WHERE status = 'running';
