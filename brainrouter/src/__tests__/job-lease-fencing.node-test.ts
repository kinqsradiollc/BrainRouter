/**
 * ADR-027 D12 — job lease correctness, against a real scratch Postgres.
 *
 * Every test here encodes a failure that was reachable before this change:
 *
 *   - a stalled worker overwriting the run that replaced it (no fencing token)
 *   - two concurrent enqueues of the same work both inserting (read-then-write)
 *   - `failMemoryJob` driving attempts past maxAttempts (no status predicate)
 *   - a crashed worker's job being cancelled outright instead of retried
 *   - lease expiry decided by a worker's own clock rather than the database's
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import {
  claimNextMemoryJob,
  sweepStuckMemoryJobs,
} from "../memory/store/postgres/queries/jobQueries.js";

function execOf(store: unknown): Parameters<typeof claimNextMemoryJob>[0] {
  return (store as { exec: Parameters<typeof claimNextMemoryJob>[0] }).exec;
}

test("a reclaimed lease fences the original worker's write-back", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "some_job", input: { a: 1 }, maxAttempts: 5 });
    const claimed = await store.startMemoryJob(job.id);
    assert.ok(claimed);
    const staleEpoch = claimed.leaseEpoch;
    assert.equal(staleEpoch, 1, "claiming issues the first epoch");

    // The worker stalls; the sweeper reclaims the lease and it is re-issued.
    const exec = execOf(store);
    await exec.run("UPDATE memory_jobs SET locked_at = $1 WHERE id = $2",
      [new Date(Date.now() - 60_000).toISOString(), job.id]);
    assert.equal(await sweepStuckMemoryJobs(exec, 1_000), 1);
    const reclaimed = await store.startMemoryJob(job.id);
    assert.ok(reclaimed, "a swept job is re-armed to pending and claimable again");
    assert.ok(reclaimed.leaseEpoch > staleEpoch, "the new holder gets a newer epoch");

    // The stalled worker wakes up and tries to publish its result.
    const stale = await store.completeMemoryJob(job.id, { from: "stale worker" }, { leaseEpoch: staleEpoch });
    assert.equal(stale, null, "a stale epoch must not complete the job");
    const afterStale = await store.getMemoryJob(job.id);
    assert.equal(afterStale?.status, "running", "the live run is untouched");

    // Failing with the stale epoch is rejected too.
    assert.equal(await store.failMemoryJob(job.id, "stale", { leaseEpoch: staleEpoch }), null);

    // The rightful holder still completes normally.
    const done = await store.completeMemoryJob(job.id, { from: "live worker" }, { leaseEpoch: reclaimed.leaseEpoch });
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.output, { from: "live worker" });
  } finally {
    await cleanup();
  }
});

test("an omitted epoch keeps the unfenced behavior for single-owner callers", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "some_job", input: {} });
    await store.startMemoryJob(job.id);
    const done = await store.completeMemoryJob(job.id, { ok: true });
    assert.equal(done?.status, "done");
  } finally {
    await cleanup();
  }
});

test("concurrent enqueues of the same key produce exactly one in-flight job", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const enqueue = () => store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "orgA", repo: "a/b", prNumber: 7 },
      idempotencyKey: "orgA:a/b:7:security",
    });
    const results = await Promise.all([enqueue(), enqueue(), enqueue(), enqueue()]);
    const ids = new Set(results.map((job) => job.id));
    assert.equal(ids.size, 1, "all four callers must receive the same job");

    const inFlight = await store.listMemoryJobs({ kind: "pr-security-review", status: ["pending", "running"] });
    assert.equal(inFlight.length, 1, "the database must hold exactly one in-flight row");
  } finally {
    await cleanup();
  }
});

test("the same key is enqueueable again once the previous job is terminal", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const key = "orgA:a/b:7:security";
    const first = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "orgA" }, idempotencyKey: key });
    await store.startMemoryJob(first.id);
    await store.completeMemoryJob(first.id, { ok: true });

    const second = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "orgA" }, idempotencyKey: key });
    assert.notEqual(second.id, first.id, "a terminal job must not block the next run");
  } finally {
    await cleanup();
  }
});

test("jobs without an idempotency key are never deduplicated", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const a = await store.enqueueMemoryJob({ kind: "some_job", input: { n: 1 } });
    const b = await store.enqueueMemoryJob({ kind: "some_job", input: { n: 1 } });
    assert.notEqual(a.id, b.id);
  } finally {
    await cleanup();
  }
});

test("failMemoryJob re-arms with backoff, then goes terminal exactly at maxAttempts", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "some_job", input: {}, maxAttempts: 2 });

    await store.startMemoryJob(job.id);
    const first = await store.failMemoryJob(job.id, "boom", { backoffMs: 5_000 });
    assert.equal(first?.status, "pending", "attempts remain, so it re-arms");
    assert.equal(first?.attempts, 1);
    assert.ok(Date.parse(first!.runAfter) > Date.now(), "backoff pushes runAfter into the future");

    await store.startMemoryJob(job.id);
    const second = await store.failMemoryJob(job.id, "boom again");
    assert.equal(second?.status, "failed", "maxAttempts exhausted");
    assert.equal(second?.attempts, 2);

    // A second failure against a terminal job is a no-op, not an increment.
    assert.equal(await store.failMemoryJob(job.id, "late"), null);
    assert.equal((await store.getMemoryJob(job.id))?.attempts, 2);
  } finally {
    await cleanup();
  }
});

test("a swept job is retried, not cancelled, until attempts are exhausted", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const expire = async (id: string) => {
      await exec.run("UPDATE memory_jobs SET locked_at = $1 WHERE id = $2",
        [new Date(Date.now() - 60_000).toISOString(), id]);
    };

    const job = await store.enqueueMemoryJob({ kind: "some_job", input: {}, maxAttempts: 2 });
    await store.startMemoryJob(job.id);
    await expire(job.id);
    assert.equal(await sweepStuckMemoryJobs(exec, 1_000), 1);

    const afterFirst = await store.getMemoryJob(job.id);
    assert.equal(afterFirst?.status, "pending", "a crashed worker is a retryable fault");
    assert.equal(afterFirst?.attempts, 1);
    assert.equal(afterFirst?.lockedAt, null);

    await store.startMemoryJob(job.id);
    await expire(job.id);
    assert.equal(await sweepStuckMemoryJobs(exec, 1_000), 1);

    const afterSecond = await store.getMemoryJob(job.id);
    assert.equal(afterSecond?.status, "failed", "only terminal once attempts are exhausted");
    assert.equal(afterSecond?.attempts, 2);
  } finally {
    await cleanup();
  }
});

test("a healthy lease is not swept, and expiry uses the database clock", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const job = await store.enqueueMemoryJob({ kind: "some_job", input: {} });
    await store.startMemoryJob(job.id);

    // Freshly claimed: well inside the threshold, so it must survive.
    assert.equal(await sweepStuckMemoryJobs(exec, 60_000), 0);
    assert.equal((await store.getMemoryJob(job.id))?.status, "running");

    // A caller whose own clock is an hour fast must NOT be able to expire it:
    // the comparison is against now() in the database, not the supplied `now`.
    const skewed = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(await sweepStuckMemoryJobs(exec, 60_000, { now: skewed }), 0,
      "a skewed worker clock must not steal a healthy peer's lease");
    assert.equal((await store.getMemoryJob(job.id))?.status, "running");
  } finally {
    await cleanup();
  }
});

test("dedup is scoped by tenant — one org cannot suppress or read another's job", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // Same kind, same logical key, DIFFERENT tenants. Before migration 049 the
    // index ignored the tenant, so the second caller received the first
    // tenant's full job record — cross-tenant disclosure, and a trivial way to
    // suppress another tenant's work by enqueueing first.
    const key = "a/b:7:security";
    const orgA = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "orgA", repo: "a/b", prNumber: 7, secret: "A-only" },
      idempotencyKey: key,
    });
    const orgB = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "orgB", repo: "a/b", prNumber: 7 },
      idempotencyKey: key,
    });

    assert.notEqual(orgB.id, orgA.id, "orgB must get its own job, not orgA's");
    assert.equal((orgB.input as { orgId: string }).orgId, "orgB");
    assert.equal((orgB.input as { secret?: string }).secret, undefined,
      "orgB must never receive orgA's job payload");

    // Dedup still holds WITHIN a tenant.
    const orgAAgain = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "orgA", repo: "a/b", prNumber: 7 },
      idempotencyKey: key,
    });
    assert.equal(orgAAgain.id, orgA.id);
  } finally {
    await cleanup();
  }
});

test("tenant-less jobs still deduplicate (NULL tenants must not compare distinct)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // A bare `tenant` column in the unique index would silently stop
    // deduplicating these, because NULLs compare as distinct in Postgres.
    const first = await store.enqueueMemoryJob({ kind: "some_job", input: { n: 1 }, idempotencyKey: "k" });
    const second = await store.enqueueMemoryJob({ kind: "some_job", input: { n: 1 }, idempotencyKey: "k" });
    assert.equal(second.id, first.id);
  } finally {
    await cleanup();
  }
});

test("a duplicate enqueue whose winner already finished inserts instead of throwing", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const key = "burst-key";
    const winner = await store.enqueueMemoryJob({ kind: "some_job", input: {}, idempotencyKey: key });
    await store.startMemoryJob(winner.id);
    await store.completeMemoryJob(winner.id, { ok: true });

    // The winner is terminal, so it has left the partial index. A second
    // enqueue must produce a fresh job rather than failing to resolve one.
    const next = await store.enqueueMemoryJob({ kind: "some_job", input: {}, idempotencyKey: key });
    assert.notEqual(next.id, winner.id);
    assert.equal(next.status, "pending");
  } finally {
    await cleanup();
  }
});

test("claiming through the queue issues an epoch the caller can fence with", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    await store.enqueueMemoryJob({ kind: "some_job", input: { n: 1 } });
    const claimed = await claimNextMemoryJob(exec);
    assert.ok(claimed);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.leaseEpoch, 1);
    assert.equal(await store.completeMemoryJob(claimed.id, { ok: true }, { leaseEpoch: 999 }), null);
    assert.ok(await store.completeMemoryJob(claimed.id, { ok: true }, { leaseEpoch: claimed.leaseEpoch }));
  } finally {
    await cleanup();
  }
});
