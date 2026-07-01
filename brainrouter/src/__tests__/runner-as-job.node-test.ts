/**
 * BRAIN-P1-T3 (0.4.1) — `runAsJob` observability wrapper contract.
 *
 * Real store (Postgres pgvector) → runs under `node --test`.
 *
 * Covers:
 *   - success path: a done job row with the summarized output, and the
 *     stage result passed through unchanged.
 *   - failure path: a terminal `failed` row (NOT a re-armed pending,
 *     since there is no runner yet) + the original error re-thrown.
 *   - the row is created synchronously (visible before fn resolves).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runAsJob } from "../memory/scheduler/runner.js";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import { createTestStore } from "./helpers/pgTestStore.js";

test("runAsJob records a done row and returns the stage result", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const { result, job } = await runAsJob(
      store as unknown as IMemoryStore,
      "cognitive_extractor",
      { userId: "u1", sensoryIds: ["s1"] },
      async () => ({ records: [1, 2, 3] }),
      { summarize: (r) => ({ records: r.records.length }) },
    );
    assert.deepEqual(result, { records: [1, 2, 3] });
    assert.equal(job.status, "done");
    assert.deepEqual(job.output, { records: 3 });
    assert.equal(job.kind, "cognitive_extractor");
    // Exactly one job row, terminal done.
    const all = await store.listMemoryJobs({ kind: "cognitive_extractor" });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "done");
  } finally {
    await cleanup();
  }
});

test("runAsJob records a terminal failed row and re-throws", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await assert.rejects(
      () =>
        runAsJob(store as unknown as IMemoryStore, "graph_extractor", { userId: "u1", recordIds: ["r1"] }, async () => {
          throw new Error("graph boom");
        }),
      /graph boom/,
    );
    const all = await store.listMemoryJobs({ kind: "graph_extractor" });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "failed"); // not re-armed to pending — no runner yet
    assert.equal(all[0].error, "graph boom");
    assert.equal(all[0].attempts, 1);
  } finally {
    await cleanup();
  }
});

test("runAsJob creates the row synchronously (visible before fn resolves)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    let seenWhilePending = -1;
    const promise = runAsJob(store as unknown as IMemoryStore, "memory_deduper", { userId: "u1", recordIds: ["r1"] }, async () => {
      // By the time fn runs, the row already exists in 'running'.
      seenWhilePending = (await store.listMemoryJobs({ kind: "memory_deduper", status: "running" })).length;
      return { unique: 1, dropped: 0 };
    });
    await promise;
    assert.equal(seenWhilePending, 1);
  } finally {
    await cleanup();
  }
});
