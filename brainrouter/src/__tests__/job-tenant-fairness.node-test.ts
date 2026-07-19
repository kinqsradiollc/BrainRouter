/**
 * Review-queue fairness (per-tenant cap) + supersede-cancel + the tenant column
 * migration — exercised against a real scratch Postgres (docker pgvector), driven
 * manually so the lifecycle is deterministic.
 *
 * Covers:
 *   - claimNextMemoryJob per-tenant cap: a tenant already at its running limit is
 *     SKIPPED while another tenant's pending job is claimed; a NULL-tenant job is
 *     exempt from the cap.
 *   - cancelSupersededReviewJobs cancels a prior PENDING review for the same PR,
 *     but never a different PR and never a RUNNING review.
 *   - migration 039: the `tenant` column exists and enqueue populates it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import {
  cancelSupersededReviewJobs,
  claimNextMemoryJob,
} from "../memory/store/postgres/queries/jobQueries.js";

/** Reach the store's raw executor for the free-function queries. */
function execOf(store: unknown): Parameters<typeof claimNextMemoryJob>[0] {
  return (store as { exec: Parameters<typeof claimNextMemoryJob>[0] }).exec;
}

test("migration 039 adds the tenant column and enqueue populates it", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const review = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "orgA", repo: "a/b", prNumber: 1 } });
    const maint = await store.enqueueMemoryJob({ kind: "identity_distiller", input: { userId: "u1" } });
    const anon = await store.enqueueMemoryJob({ kind: "some_job", input: {} });
    const exec = execOf(store);
    const tenant = async (id: string) => (await exec.one<{ tenant: string | null }>("SELECT tenant FROM memory_jobs WHERE id = $1", [id]))!.tenant;
    assert.equal(await tenant(review.id), "orgA");
    assert.equal(await tenant(maint.id), "u1");
    assert.equal(await tenant(anon.id), null);
  } finally {
    await cleanup();
  }
});

test("per-tenant cap skips a saturated tenant but claims another tenant + null-tenant", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    // Tenant A: one already running, one pending. Cap of 1 ⇒ A's pending is ineligible.
    const aRunning = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "A", repo: "a/b", prNumber: 1 } });
    await store.startMemoryJob(aRunning.id); // now 'running'
    await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "A", repo: "a/b", prNumber: 2 } });
    // Tenant B: one pending, no running ⇒ eligible.
    const bPending = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "B", repo: "c/d", prNumber: 3 } });
    // Null-tenant maintenance job ⇒ exempt from the cap.
    const anon = await store.enqueueMemoryJob({ kind: "some_job", input: {} });

    const first = await claimNextMemoryJob(exec, { perTenantLimit: 1 });
    const second = await claimNextMemoryJob(exec, { perTenantLimit: 1 });
    const third = await claimNextMemoryJob(exec, { perTenantLimit: 1 });

    const claimedIds = new Set([first?.id, second?.id, third?.id]);
    assert.ok(claimedIds.has(bPending.id), "tenant B's pending was claimed");
    assert.ok(claimedIds.has(anon.id), "null-tenant job was claimed (exempt)");
    // A's second job must NOT have been claimed while A already had one running.
    const aSecond = (await store.listMemoryJobs({ kind: "pr-security-review", status: "pending" })).find((j) => (j.input as { prNumber?: number }).prNumber === 2);
    assert.ok(aSecond, "tenant A's second review stays pending (skipped by the cap)");
  } finally {
    await cleanup();
  }
});

test("supersede-cancel drops a prior PENDING review for the same PR only", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const priorPending = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "A", repo: "a/b", prNumber: 7 } });
    const otherPr = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "A", repo: "a/b", prNumber: 8 } });
    const running = await store.enqueueMemoryJob({ kind: "pr-code-review", input: { orgId: "A", repo: "a/b", prNumber: 7 } });
    await store.startMemoryJob(running.id); // running review must survive
    const otherOrg = await store.enqueueMemoryJob({ kind: "pr-security-review", input: { orgId: "B", repo: "a/b", prNumber: 7 } });

    const cancelled = await cancelSupersededReviewJobs(exec, { orgId: "A", repo: "a/b", prNumber: 7 });
    assert.equal(cancelled, 1, "only the prior PENDING review for PR 7 in org A is cancelled");

    assert.equal((await store.getMemoryJob(priorPending.id))!.status, "cancelled");
    assert.equal((await store.getMemoryJob(otherPr.id))!.status, "pending", "a different PR is untouched");
    assert.equal((await store.getMemoryJob(running.id))!.status, "running", "a running review is left to finish");
    assert.equal((await store.getMemoryJob(otherOrg.id))!.status, "pending", "another org's review is untouched");
  } finally {
    await cleanup();
  }
});
