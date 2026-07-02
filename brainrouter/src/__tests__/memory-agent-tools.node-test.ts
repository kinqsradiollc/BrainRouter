/**
 * BRAIN-P1-T4 (0.4.1) — `memory_agent_*` MCP tool integration.
 *
 * The tool handlers talk to the `memoryEngine` SINGLETON (constructed at
 * import time from the env connection string), so — unlike the helper-based
 * tests that inject an isolated store — we must provision a scratch Postgres
 * DATABASE and point `BRAINROUTER_DATABASE_URL` at it BEFORE importing the
 * engine. Otherwise the singleton binds to the shared dev DB and these
 * "idle before any jobs" assertions flake on residue from other runs.
 *
 * Covers:
 *   - memory_agent_status returns all registry agents, idle when no jobs
 *     have run, and reflects a pending job afterwards.
 *   - memory_agent_status with an unknown agentId errors.
 *   - memory_agent_run queues a job (returns jobId + status) and is
 *     idempotent (second identical run returns the same jobId).
 *   - memory_agent_run rejects an unknown agentId.
 *   - memory_job_retry re-arms a failed job; errors on a missing job.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// Provision an isolated scratch DATABASE and bind the engine singleton to it
// BEFORE the dynamic imports below construct it. Mirrors pgTestStore's
// admin-connect + `CREATE DATABASE` mechanism (kept inline here because the
// singleton reads the env at import — it can't take an injected store).
const ADMIN_URL =
  process.env.BRAINROUTER_TEST_PG_ADMIN_URL ??
  process.env.BRAINROUTER_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

const SCRATCH_DB = `br_test_agenttools_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function scratchUrl(): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

{
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

// Bind the singleton (and anything it constructs) to the scratch DB. Disable the
// background job runner so it doesn't race these job-count assertions.
process.env.BRAINROUTER_DATABASE_URL = scratchUrl();
process.env.DATABASE_URL = scratchUrl();
process.env.BRAINROUTER_JOB_RUNNER = "off";

const { handleMemoryAgentStatus } = await import("../tools/agents/memory_agent_status.js");
const { handleMemoryAgentRun } = await import("../tools/agents/memory_agent_run.js");
const { handleMemoryJobRetry } = await import("../tools/agents/memory_job_retry.js");
const { memoryEngine } = await import("../memory/engine.js");

// The Postgres store is genuinely async — wait for migrations / seed-admin
// before the first store-using call.
await memoryEngine.ready;

test.after(async () => {
  // `close` is PostgresMemoryStore-specific (not on IMemoryStore) — drain the
  // pool so the scratch DB can be dropped without lingering backends.
  await (memoryEngine.store as Partial<{ close(): Promise<void> }>).close?.().catch(() => undefined);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [SCRATCH_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  } catch {
    /* best-effort cleanup */
  } finally {
    await admin.end().catch(() => undefined);
  }
});

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

test("memory_agent_status lists all 14 agents, idle before any jobs", async () => {
  const res = await handleMemoryAgentStatus({});
  const { agents } = parse(res);
  assert.equal(agents.length, 14);
  const extractor = agents.find((a: any) => a.id === "cognitive_extractor");
  assert.equal(extractor.lastJobStatus, "idle");
  assert.equal(extractor.pendingJobs, 0);
  assert.equal(extractor.successRate24h, null);
});

test("memory_agent_status errors on an unknown agentId", async () => {
  const res = await handleMemoryAgentStatus({ agentId: "ghost" });
  assert.equal(res.isError, true);
});

test("memory_agent_run queues a job and is idempotent", async () => {
  const first = parse(await handleMemoryAgentRun({ agentId: "cognitive_extractor", input: { sensoryIds: ["s1"] } }));
  assert.ok(first.jobId);
  assert.equal(first.status, "pending");
  assert.equal(first.deduped, false);

  // Same input while pending → same job id, deduped.
  const second = parse(await handleMemoryAgentRun({ agentId: "cognitive_extractor", input: { sensoryIds: ["s1"] } }));
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.deduped, true);

  // Status now reflects the pending job.
  const { agents } = parse(await handleMemoryAgentStatus({ agentId: "cognitive_extractor" }));
  assert.equal(agents[0].pendingJobs, 1);
  assert.equal(agents[0].lastJobStatus, "pending");
});

test("memory_agent_run rejects an unknown agentId", async () => {
  const res = await handleMemoryAgentRun({ agentId: "ghost", input: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Unknown brain agent/);
});

test("memory_job_retry re-arms a non-running job; errors on a missing job", async () => {
  // Enqueue a fresh job, then cancel it by id (avoids coupling to the
  // claim queue, which may hold pending jobs from earlier tests). The
  // retry contract covers both `failed` and `cancelled`.
  const queued = parse(await handleMemoryAgentRun({ agentId: "memory_deduper", input: { recordIds: ["r1"] } }));
  const store = memoryEngine.store;
  const cancelled = (await store.cancelMemoryJob(queued.jobId))!;
  assert.equal(cancelled.status, "cancelled");

  const retried = parse(await handleMemoryJobRetry({ jobId: queued.jobId }));
  assert.equal(retried.status, "pending");
  assert.equal((await store.getMemoryJob(queued.jobId))!.attempts, 0);

  const missing = await handleMemoryJobRetry({ jobId: "no-such-job" });
  assert.equal(missing.isError, true);
});
