/**
 * BRAIN-P1-T4 (0.4.1) — `memory_agent_*` MCP tool integration.
 *
 * Real store (node:sqlite) → runs under `node --test`. The tool
 * handlers talk to the `memoryEngine` singleton, so we point
 * BRAINROUTER_MEMORY_DB at a temp file BEFORE importing them.
 *
 * Covers:
 *   - memory_agent_status returns all 8 registry agents, idle when no
 *     jobs have run, and reflects a pending job afterwards.
 *   - memory_agent_status with an unknown agentId errors.
 *   - memory_agent_run queues a job (returns jobId + status) and is
 *     idempotent (second identical run returns the same jobId).
 *   - memory_agent_run rejects an unknown agentId.
 *   - memory_job_retry re-arms a failed job; errors on a missing job.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before the engine singleton is constructed on import.
process.env.BRAINROUTER_MEMORY_DB = join(
  mkdtempSync(join(tmpdir(), "brainrouter-agent-tools-")),
  "memory.db",
);

const { handleMemoryAgentStatus } = await import("../tools/memory_agent_status.js");
const { handleMemoryAgentRun } = await import("../tools/memory_agent_run.js");
const { handleMemoryJobRetry } = await import("../tools/memory_job_retry.js");
const { memoryEngine } = await import("../memory/engine.js");

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
  const cancelled = store.cancelMemoryJob(queued.jobId)!;
  assert.equal(cancelled.status, "cancelled");

  const retried = parse(await handleMemoryJobRetry({ jobId: queued.jobId }));
  assert.equal(retried.status, "pending");
  assert.equal(store.getMemoryJob(queued.jobId)!.attempts, 0);

  const missing = await handleMemoryJobRetry({ jobId: "no-such-job" });
  assert.equal(missing.isError, true);
});
