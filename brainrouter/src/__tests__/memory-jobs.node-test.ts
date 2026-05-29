/**
 * BRAIN-P1-T1 (0.4.1) — `memory_jobs` store contract (BRAIN-DESIGN-T2).
 *
 * Runs under `node --test` (see sqlite-wal.node-test.ts for the
 * vitest/node:sqlite limitation that pushed integration tests onto
 * the native node test runner).
 *
 * Covers the full lifecycle:
 *   - enqueue → poll/list → claim (pending → running) → complete (→ done).
 *   - priority + runAfter eligibility ordering in claimNextMemoryJob.
 *   - failMemoryJob re-arms to pending (attempts++) while attempts <
 *     maxAttempts, then moves to failed; backoffMs pushes runAfter out.
 *   - retryMemoryJob re-arms failed/cancelled (attempts→0); no-op for
 *     pending/running/done.
 *   - cancelMemoryJob + sweepStuckMemoryJobs.
 *   - getMemoryJobKindAggregates rollups (last status, pending, 24h rate).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-jobs-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("memory_jobs: enqueue → claim → complete happy path", () => {
  const { store, cleanup } = freshDb("happy");
  try {
    const job = store.enqueueMemoryJob({ kind: "cognitive_extractor", input: { sensoryIds: ["s1"] } });
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.deepEqual(job.input, { sensoryIds: ["s1"] });

    const polled = store.listMemoryJobs({ status: "pending" });
    assert.equal(polled.length, 1);
    assert.equal(polled[0].id, job.id);

    const claimed = store.claimNextMemoryJob();
    assert.ok(claimed);
    assert.equal(claimed!.id, job.id);
    assert.equal(claimed!.status, "running");
    assert.ok(claimed!.lockedAt);

    // No more eligible jobs once the only one is running.
    assert.equal(store.claimNextMemoryJob(), null);

    const done = store.completeMemoryJob(job.id, { records: 2 });
    assert.ok(done);
    assert.equal(done!.status, "done");
    assert.equal(done!.lockedAt, null);
    assert.deepEqual(done!.output, { records: 2 });
  } finally {
    cleanup();
  }
});

test("memory_jobs: claim respects priority then runAfter", () => {
  const { store, cleanup } = freshDb("priority");
  try {
    store.enqueueMemoryJob({ kind: "a", input: {}, priority: 10 });
    const high = store.enqueueMemoryJob({ kind: "b", input: {}, priority: 90 });
    // A future-dated high-priority job must NOT be picked before its runAfter.
    store.enqueueMemoryJob({ kind: "c", input: {}, priority: 99, runAfter: iso(60_000) });

    const first = store.claimNextMemoryJob({ now: iso() });
    assert.equal(first!.id, high.id, "priority 90 beats priority 10 and the not-yet-eligible 99");
  } finally {
    cleanup();
  }
});

test("memory_jobs: failMemoryJob re-arms then fails after maxAttempts", () => {
  const { store, cleanup } = freshDb("retry");
  try {
    const job = store.enqueueMemoryJob({ kind: "flaky", input: {}, maxAttempts: 2 });

    // Attempt 1 fails → re-armed to pending, attempts = 1, runAfter pushed out.
    store.claimNextMemoryJob({ now: iso() });
    const afterFail1 = store.failMemoryJob(job.id, "boom 1", { now: iso(), backoffMs: 30_000 });
    assert.equal(afterFail1!.status, "pending");
    assert.equal(afterFail1!.attempts, 1);
    assert.ok(Date.parse(afterFail1!.runAfter) > Date.parse(iso()) - 1000, "runAfter pushed forward by backoff");
    assert.equal(afterFail1!.lockedAt, null);

    // Make it eligible again, claim, fail again → attempts hits maxAttempts → failed.
    store.claimNextMemoryJob({ now: iso(60_000) });
    const afterFail2 = store.failMemoryJob(job.id, "boom 2", { now: iso(60_000) });
    assert.equal(afterFail2!.status, "failed");
    assert.equal(afterFail2!.attempts, 2);
    assert.equal(afterFail2!.error, "boom 2");

    // failMemoryJob on a non-running job is a no-op (returns null).
    assert.equal(store.failMemoryJob(job.id, "again", {}), null);
  } finally {
    cleanup();
  }
});

test("memory_jobs: retryMemoryJob re-arms failed jobs, no-op otherwise", () => {
  const { store, cleanup } = freshDb("retrytool");
  try {
    const job = store.enqueueMemoryJob({ kind: "k", input: {}, maxAttempts: 1 });
    store.claimNextMemoryJob({ now: iso() });
    const failed = store.failMemoryJob(job.id, "dead", { now: iso() });
    assert.equal(failed!.status, "failed");

    const retried = store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(retried!.status, "pending");
    assert.equal(retried!.attempts, 0);
    assert.equal(retried!.error, null);

    // No-op on a pending job (already pending) — attempts stay 0, still pending.
    const noop = store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(noop!.status, "pending");

    // No-op on a done job.
    store.claimNextMemoryJob({ now: iso() });
    store.completeMemoryJob(job.id, {});
    const afterDone = store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(afterDone!.status, "done");
  } finally {
    cleanup();
  }
});

test("memory_jobs: cancel + sweepStuckMemoryJobs", () => {
  const { store, cleanup } = freshDb("sweep");
  try {
    const pending = store.enqueueMemoryJob({ kind: "k", input: {} });
    const cancelled = store.cancelMemoryJob(pending.id);
    assert.equal(cancelled!.status, "cancelled");

    // A running job whose lock has aged past the cutoff gets swept.
    const stuck = store.enqueueMemoryJob({ kind: "k", input: {} });
    store.claimNextMemoryJob({ now: iso() }); // locked "now"
    // Sweep from 10 min in the future with a 5 min stuck window → cutoff
    // is +5 min, and the lock (taken "now") is older than that.
    const swept = store.sweepStuckMemoryJobs(5 * 60_000, { now: iso(10 * 60_000) });
    assert.equal(swept, 1);
    assert.equal(store.getMemoryJob(stuck.id)!.status, "cancelled");
  } finally {
    cleanup();
  }
});

test("memory_jobs: getMemoryJobKindAggregates rolls up per kind", () => {
  const { store, cleanup } = freshDb("agg");
  try {
    // kind A: one done, one failed → success rate 0.5; no pending.
    const a1 = store.enqueueMemoryJob({ kind: "A", input: {}, maxAttempts: 1 });
    store.claimNextMemoryJob({ now: iso() });
    store.completeMemoryJob(a1.id, {});
    const a2 = store.enqueueMemoryJob({ kind: "A", input: {}, maxAttempts: 1 });
    store.claimNextMemoryJob({ now: iso() });
    store.failMemoryJob(a2.id, "x", { now: iso() });

    // kind B: one pending only → null success rate, 1 pending.
    store.enqueueMemoryJob({ kind: "B", input: {} });

    const aggs = store.getMemoryJobKindAggregates({ now: iso() });
    const byKind = Object.fromEntries(aggs.map((x) => [x.kind, x]));
    assert.equal(byKind["A"].successRate24h, 0.5);
    assert.equal(byKind["A"].pendingJobs, 0);
    assert.ok(byKind["A"].lastCompletedAt, "A has a completed job");
    assert.equal(byKind["B"].successRate24h, null);
    assert.equal(byKind["B"].pendingJobs, 1);
    assert.equal(byKind["B"].lastStatus, "pending");
  } finally {
    cleanup();
  }
});
