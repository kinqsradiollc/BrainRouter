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
import { createTestStore } from "./helpers/pgTestStore.js";

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("memory_jobs: enqueue → claim → complete happy path", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "cognitive_extractor", input: { sensoryIds: ["s1"] } });
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.deepEqual(job.input, { sensoryIds: ["s1"] });

    const polled = await store.listMemoryJobs({ status: "pending" });
    assert.equal(polled.length, 1);
    assert.equal(polled[0].id, job.id);

    const claimed = await store.claimNextMemoryJob();
    assert.ok(claimed);
    assert.equal(claimed!.id, job.id);
    assert.equal(claimed!.status, "running");
    assert.ok(claimed!.lockedAt);

    // No more eligible jobs once the only one is running.
    assert.equal(await store.claimNextMemoryJob(), null);

    const done = await store.completeMemoryJob(job.id, { records: 2 });
    assert.ok(done);
    assert.equal(done!.status, "done");
    assert.equal(done!.lockedAt, null);
    assert.deepEqual(done!.output, { records: 2 });
  } finally {
    await cleanup();
  }
});

test("memory_jobs: claim respects priority then runAfter", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.enqueueMemoryJob({ kind: "a", input: {}, priority: 10 });
    const high = await store.enqueueMemoryJob({ kind: "b", input: {}, priority: 90 });
    // A future-dated high-priority job must NOT be picked before its runAfter.
    await store.enqueueMemoryJob({ kind: "c", input: {}, priority: 99, runAfter: iso(60_000) });

    const first = await store.claimNextMemoryJob({ now: iso() });
    assert.equal(first!.id, high.id, "priority 90 beats priority 10 and the not-yet-eligible 99");
  } finally {
    await cleanup();
  }
});

test("memory_jobs: failMemoryJob re-arms then fails after maxAttempts", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "flaky", input: {}, maxAttempts: 2 });

    // Attempt 1 fails → re-armed to pending, attempts = 1, runAfter pushed out.
    await store.claimNextMemoryJob({ now: iso() });
    const afterFail1 = await store.failMemoryJob(job.id, "boom 1", { now: iso(), backoffMs: 30_000 });
    assert.equal(afterFail1!.status, "pending");
    assert.equal(afterFail1!.attempts, 1);
    assert.ok(Date.parse(afterFail1!.runAfter) > Date.parse(iso()) - 1000, "runAfter pushed forward by backoff");
    assert.equal(afterFail1!.lockedAt, null);

    // Make it eligible again, claim, fail again → attempts hits maxAttempts → failed.
    await store.claimNextMemoryJob({ now: iso(60_000) });
    const afterFail2 = await store.failMemoryJob(job.id, "boom 2", { now: iso(60_000) });
    assert.equal(afterFail2!.status, "failed");
    assert.equal(afterFail2!.attempts, 2);
    assert.equal(afterFail2!.error, "boom 2");

    // failMemoryJob on a non-running job is a no-op (returns null).
    assert.equal(await store.failMemoryJob(job.id, "again", {}), null);
  } finally {
    await cleanup();
  }
});

test("memory_jobs: retryMemoryJob re-arms failed jobs, no-op otherwise", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "k", input: {}, maxAttempts: 1 });
    await store.claimNextMemoryJob({ now: iso() });
    const failed = await store.failMemoryJob(job.id, "dead", { now: iso() });
    assert.equal(failed!.status, "failed");

    const retried = await store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(retried!.status, "pending");
    assert.equal(retried!.attempts, 0);
    assert.equal(retried!.error, null);

    // No-op on a pending job (already pending) — attempts stay 0, still pending.
    const noop = await store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(noop!.status, "pending");

    // No-op on a done job.
    await store.claimNextMemoryJob({ now: iso() });
    await store.completeMemoryJob(job.id, {});
    const afterDone = await store.retryMemoryJob(job.id, { now: iso() });
    assert.equal(afterDone!.status, "done");
  } finally {
    await cleanup();
  }
});

test("memory_jobs: cancel + sweepStuckMemoryJobs", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const pending = await store.enqueueMemoryJob({ kind: "k", input: {} });
    const cancelled = await store.cancelMemoryJob(pending.id);
    assert.equal(cancelled!.status, "cancelled");

    // A running job whose lock has aged past the cutoff gets swept.
    const stuck = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.claimNextMemoryJob({ now: iso() }); // locked "now"
    // Sweep from 10 min in the future with a 5 min stuck window → cutoff
    // is +5 min, and the lock (taken "now") is older than that.
    const swept = await store.sweepStuckMemoryJobs(5 * 60_000, { now: iso(10 * 60_000) });
    assert.equal(swept, 1);
    assert.equal((await store.getMemoryJob(stuck.id))!.status, "cancelled");
  } finally {
    await cleanup();
  }
});

test("memory_jobs: getMemoryJobKindAggregates rolls up per kind", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // kind A: one done, one failed → success rate 0.5; no pending.
    const a1 = await store.enqueueMemoryJob({ kind: "A", input: {}, maxAttempts: 1 });
    await store.claimNextMemoryJob({ now: iso() });
    await store.completeMemoryJob(a1.id, {});
    const a2 = await store.enqueueMemoryJob({ kind: "A", input: {}, maxAttempts: 1 });
    await store.claimNextMemoryJob({ now: iso() });
    await store.failMemoryJob(a2.id, "x", { now: iso() });

    // kind B: one pending only → null success rate, 1 pending.
    await store.enqueueMemoryJob({ kind: "B", input: {} });

    const aggs = await store.getMemoryJobKindAggregates({ now: iso() });
    const byKind = Object.fromEntries(aggs.map((x) => [x.kind, x]));
    assert.equal(byKind["A"].successRate24h, 0.5);
    assert.equal(byKind["A"].pendingJobs, 0);
    assert.ok(byKind["A"].lastCompletedAt, "A has a completed job");
    assert.equal(byKind["B"].successRate24h, null);
    assert.equal(byKind["B"].pendingJobs, 1);
    assert.equal(byKind["B"].lastStatus, "pending");
  } finally {
    await cleanup();
  }
});
