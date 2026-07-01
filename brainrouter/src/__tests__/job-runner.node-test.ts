/**
 * BRAIN-P1 (0.4.1) — async job runner contract.
 *
 * Real store (Postgres scratch DB) → runs under `node --test`. Ticks are driven
 * manually (no timer) and executors are injected so the lifecycle is
 * deterministic and independent of the real distillers / LLM.
 *
 * Covers:
 *   - drains an enqueued job through a stub executor → done + output.
 *   - a job whose kind has no executor is cancelled with a clear reason.
 *   - a throwing executor on a maxAttempts:1 job → terminal failed.
 *   - maxPerTick bounds how many jobs one tick drains.
 *   - the default resolver maps the real on-demand agents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import type { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";
import { MemoryJobRunner } from "../memory/scheduler/runner.js";
import { enqueueAgentJob } from "../memory/scheduler/jobs.js";
import { getJobExecutor } from "../memory/scheduler/executors.js";

const ctx = (store: PostgresMemoryStore) => ({ store, llmRunner: { run: async () => "" } as any });

test("runner drains a job through its executor to done with output", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const { job } = await enqueueAgentJob(store, "identity_distiller", { userId: "u1" });
    const runner = new MemoryJobRunner(store, ctx(store), {
      resolveExecutor: () => async (input: any) => ({ ranFor: input.userId }),
    });
    await runner.tick();
    const after = (await store.getMemoryJob(job.id))!;
    assert.equal(after.status, "done");
    assert.deepEqual(after.output, { ranFor: "u1" });
  } finally {
    await cleanup();
  }
});

test("runner cancels a job whose kind has no executor, with a clear reason", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const { job } = await enqueueAgentJob(store, "cognitive_extractor", { userId: "u1", sensoryIds: ["s1"] });
    const runner = new MemoryJobRunner(store, ctx(store), { resolveExecutor: () => undefined });
    await runner.tick();
    const after = (await store.getMemoryJob(job.id))!;
    assert.equal(after.status, "cancelled");
    assert.match(after.error ?? "", /no on-demand executor/);
  } finally {
    await cleanup();
  }
});

test("runner records a throwing executor as terminal failed (maxAttempts 1)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // Enqueue raw with maxAttempts:1 so the first failure is terminal.
    const job = await store.enqueueMemoryJob({ kind: "identity_distiller", input: { userId: "u1" }, maxAttempts: 1 });
    const runner = new MemoryJobRunner(store, ctx(store), {
      resolveExecutor: () => async () => {
        throw new Error("executor boom");
      },
    });
    await runner.tick();
    const after = (await store.getMemoryJob(job.id))!;
    assert.equal(after.status, "failed");
    assert.equal(after.error, "executor boom");
    assert.equal(after.attempts, 1);
  } finally {
    await cleanup();
  }
});

test("runner re-arms a throwing executor while attempts remain (maxAttempts 2)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const job = await store.enqueueMemoryJob({ kind: "identity_distiller", input: { userId: "u1" }, maxAttempts: 2 });
    const runner = new MemoryJobRunner(store, ctx(store), {
      resolveExecutor: () => async () => {
        throw new Error("transient");
      },
    });
    await runner.tick();
    const after = (await store.getMemoryJob(job.id))!;
    assert.equal(after.status, "pending", "re-armed, not failed (1 < 2 attempts)");
    assert.equal(after.attempts, 1);
    assert.ok(Date.parse(after.runAfter) > Date.now() - 1000, "backoff pushed runAfter forward");
  } finally {
    await cleanup();
  }
});

test("maxPerTick bounds the drain", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    for (let i = 0; i < 5; i++) await enqueueAgentJob(store, "identity_distiller", { userId: `u${i}` });
    const runner = new MemoryJobRunner(store, ctx(store), {
      maxPerTick: 2,
      resolveExecutor: () => async () => ({ ok: true }),
    });
    await runner.tick();
    assert.equal((await store.listMemoryJobs({ kind: "identity_distiller", status: "done" })).length, 2);
    assert.equal((await store.listMemoryJobs({ kind: "identity_distiller", status: "pending" })).length, 3);
  } finally {
    await cleanup();
  }
});

test("default resolver binds the real on-demand agents (identity + focus distillers)", () => {
  assert.ok(getJobExecutor("identity_distiller"), "identity_distiller has an executor");
  assert.ok(getJobExecutor("focus_distiller"), "focus_distiller has an executor");
  assert.equal(getJobExecutor("cognitive_extractor"), undefined, "inline-only agents have none");
});
