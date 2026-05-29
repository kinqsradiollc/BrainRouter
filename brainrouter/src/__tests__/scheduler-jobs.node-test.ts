/**
 * BRAIN-P1 (0.4.1) — scheduler job-helper contract.
 *
 * Real store (node:sqlite) → runs under `node --test`.
 *
 * Covers:
 *   - enqueueAgentJob stamps the agent's maxAttempts.
 *   - idempotency dedup: a second enqueue with the same key while one
 *     is pending/running returns the existing job (deduped: true).
 *   - distinct inputs (distinct keys) enqueue separately.
 *   - relevance_judge (empty key) never dedupes.
 *   - UnknownBrainAgentError for unknown ids.
 *   - failAgentJob re-arms with a backoff'd runAfter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import {
  enqueueAgentJob,
  failAgentJob,
  UnknownBrainAgentError,
} from "../memory/scheduler/jobs.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-sched-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("enqueueAgentJob stamps the agent maxAttempts", () => {
  const { store, cleanup } = freshDb("max");
  try {
    const { job, deduped } = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["s1"] });
    assert.equal(deduped, false);
    assert.equal(job.kind, "cognitive_extractor");
    assert.equal(job.maxAttempts, 3); // from the registry definition
  } finally {
    cleanup();
  }
});

test("enqueueAgentJob dedupes a second enqueue with the same idempotency key", () => {
  const { store, cleanup } = freshDb("dedup");
  try {
    const first = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["a", "b"] });
    assert.equal(first.deduped, false);

    // Same ids, different order → same key → dedup to the existing job.
    const second = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["b", "a"] });
    assert.equal(second.deduped, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(store.listMemoryJobs({ kind: "cognitive_extractor" }).length, 1);

    // A different input → different key → a new job.
    const third = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["c"] });
    assert.equal(third.deduped, false);
    assert.notEqual(third.job.id, first.job.id);
    assert.equal(store.listMemoryJobs({ kind: "cognitive_extractor" }).length, 2);
  } finally {
    cleanup();
  }
});

test("dedup only holds while the prior job is pending/running", () => {
  const { store, cleanup } = freshDb("inflight");
  try {
    const first = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["a"] });
    // Drive it to done.
    store.claimNextMemoryJob();
    store.completeMemoryJob(first.job.id, {});
    // Same key, but the prior job is terminal → a fresh job is enqueued.
    const again = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["a"] });
    assert.equal(again.deduped, false);
    assert.notEqual(again.job.id, first.job.id);
  } finally {
    cleanup();
  }
});

test("agents with an empty idempotency key never dedupe", () => {
  const { store, cleanup } = freshDb("nodedup");
  try {
    enqueueAgentJob(store, "relevance_judge", { query: "x", candidateIds: ["c1"] });
    const second = enqueueAgentJob(store, "relevance_judge", { query: "x", candidateIds: ["c1"] });
    assert.equal(second.deduped, false);
    assert.equal(store.listMemoryJobs({ kind: "relevance_judge" }).length, 2);
  } finally {
    cleanup();
  }
});

test("enqueueAgentJob throws UnknownBrainAgentError for unknown ids", () => {
  const { store, cleanup } = freshDb("unknown");
  try {
    assert.throws(() => enqueueAgentJob(store, "ghost_agent", {}), UnknownBrainAgentError);
  } finally {
    cleanup();
  }
});

test("failAgentJob re-arms with a future runAfter (backoff applied)", () => {
  const { store, cleanup } = freshDb("backoff");
  try {
    const { job } = enqueueAgentJob(store, "cognitive_extractor", { sensoryIds: ["s1"] });
    store.claimNextMemoryJob();
    const now = new Date().toISOString();
    const failed = failAgentJob(store, job.id, "boom", { now, random: () => 0.5 });
    assert.ok(failed);
    assert.equal(failed!.status, "pending"); // attempts 1 < maxAttempts 3 → re-armed
    assert.equal(failed!.attempts, 1);
    assert.ok(Date.parse(failed!.runAfter) > Date.parse(now), "runAfter pushed into the future");
  } finally {
    cleanup();
  }
});
