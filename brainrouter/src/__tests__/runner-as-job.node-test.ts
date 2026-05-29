/**
 * BRAIN-P1-T3 (0.4.1) — `runAsJob` observability wrapper contract.
 *
 * Real store (node:sqlite) → runs under `node --test`.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { runAsJob } from "../memory/scheduler/runner.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-runner-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("runAsJob records a done row and returns the stage result", async () => {
  const { store, cleanup } = freshDb("ok");
  try {
    const { result, job } = await runAsJob(
      store,
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
    const all = store.listMemoryJobs({ kind: "cognitive_extractor" });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "done");
  } finally {
    cleanup();
  }
});

test("runAsJob records a terminal failed row and re-throws", async () => {
  const { store, cleanup } = freshDb("fail");
  try {
    await assert.rejects(
      () =>
        runAsJob(store, "graph_extractor", { userId: "u1", recordIds: ["r1"] }, async () => {
          throw new Error("graph boom");
        }),
      /graph boom/,
    );
    const all = store.listMemoryJobs({ kind: "graph_extractor" });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "failed"); // not re-armed to pending — no runner yet
    assert.equal(all[0].error, "graph boom");
    assert.equal(all[0].attempts, 1);
  } finally {
    cleanup();
  }
});

test("runAsJob creates the row synchronously (visible before fn resolves)", async () => {
  const { store, cleanup } = freshDb("sync");
  try {
    let seenWhilePending = -1;
    const promise = runAsJob(store, "memory_deduper", { userId: "u1", recordIds: ["r1"] }, async () => {
      // By the time fn runs, the row already exists in 'running'.
      seenWhilePending = store.listMemoryJobs({ kind: "memory_deduper", status: "running" }).length;
      return { unique: 1, dropped: 0 };
    });
    await promise;
    assert.equal(seenWhilePending, 1);
  } finally {
    cleanup();
  }
});
