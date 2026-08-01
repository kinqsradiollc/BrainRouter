-- ADR-027 D12 — job lease correctness.
--
-- Two defects this closes.
--
-- 1. NO FENCING TOKEN. A worker claimed a job by flipping it to 'running' and
--    stamping `locked_at`. If that worker stalled past the sweep threshold, the
--    sweeper released the lease and a second worker could take the same job —
--    but the first worker was never told. When it woke up it still believed it
--    held the lease and wrote its (stale) result over the new run. `lease_epoch`
--    makes the lease verifiable: every claim and every sweep bumps it, and a
--    write-back that names an older epoch is rejected instead of applied.
--    See Kleppmann on fencing tokens — a lease without one is not a lock.
--
-- 2. NON-ATOMIC ENQUEUE DEDUP. `enqueueAgentJob` listed in-flight jobs and then
--    inserted, so two concurrent webhook redeliveries could both observe an
--    empty queue and both insert. The partial unique index below makes the
--    database the arbiter: at most one in-flight job per (kind, key). Terminal
--    rows leave the index, so a later run of the same work is still allowed.
--
-- Both columns are additive with safe defaults; existing rows keep working.

ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;

-- 'pending' and 'running' are the in-flight states. A job that reaches
-- done/failed/cancelled drops out of the index, which is what allows the same
-- logical work to be enqueued again later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_jobs_inflight_idempotency
  ON memory_jobs (kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'running');
