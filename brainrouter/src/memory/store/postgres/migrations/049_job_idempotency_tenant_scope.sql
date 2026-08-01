-- ADR-027 D12 follow-up — scope in-flight job dedup BY TENANT.
--
-- Migration 048 made the database the arbiter of enqueue dedup, but keyed the
-- index on (kind, idempotency_key) alone. `memory_jobs` is multi-tenant (the
-- `tenant` column is materialized at insert from the job input), so two tenants
-- using the same agent kind and the same logical key — say a key derived from a
-- repository name and PR number — would collide across the tenant boundary.
--
-- The consequences are worse than a missed dedup. `enqueueMemoryJob` resolves a
-- conflict by RETURNING the winning row, so tenant B's caller would receive
-- tenant A's full job record (input, output, progress, error). One tenant could
-- also suppress another's work simply by enqueueing first.
--
-- COALESCE is load-bearing: NULLs compare as distinct in a unique index, so a
-- bare `tenant` column would silently stop deduplicating tenant-less jobs
-- (maintenance work with neither orgId nor userId).
--
-- Relying on every agent to embed its tenant in the key would work only for as
-- long as every future agent author remembers to. The index enforces it.

DROP INDEX IF EXISTS uq_memory_jobs_inflight_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_jobs_inflight_idempotency
  ON memory_jobs (kind, COALESCE(tenant, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'running');
