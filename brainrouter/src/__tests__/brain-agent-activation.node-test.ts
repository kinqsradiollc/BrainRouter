import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { recordInlineJob } from "../memory/scheduler/runner.js";
import { readTreePolicy } from "../memory/tree/policy.js";

/**
 * MEM-10b — activation of the previously-idle depth agents:
 *  - tree_sealer fires on a SETTLED bucket (idleSealFloor) even when it never
 *    reaches the full sealThreshold, so realistic users with a few scenes get
 *    their leaves sealed (→ tree_digest chains).
 *  - benchmark_eval is auto-scheduled by maintenance (early pass for visibility).
 *  - recordInlineJob leaves an observable job row for inline work
 *    (source_chunker / blackboard_reconciler).
 */

function snapshotEnv(keys: string[]): () => void {
  const prev = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-activate-${label}-`));
  // Hermetic: don't inherit a dev .env that disables autobuild or starts a timer.
  const restoreEnv = snapshotEnv(["BRAINROUTER_JOB_RUNNER", "BRAINROUTER_TREE_AUTOBUILD"]);
  process.env.BRAINROUTER_JOB_RUNNER = "off";
  process.env.BRAINROUTER_TREE_AUTOBUILD = "on";
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store,
    engine,
    cleanup: () => {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeRecord(overrides: Partial<Record<string, unknown>> & { id: string; sceneName: string }): any {
  return {
    userId: "u1",
    sessionKey: "sk-1",
    sessionId: "sid-1",
    content: `content for ${overrides.id}`,
    type: "codebase_fact",
    priority: 50,
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    invalidAt: null,
    timestampStr: "2026-05-28",
    timestampStart: "2026-05-28T00:00:00Z",
    timestampEnd: "2026-05-28T00:00:00Z",
    createdTime: "2026-05-28T00:00:00Z",
    updatedTime: "2026-05-28T00:00:00Z",
    metadata: {},
    confidence: 0.7,
    status: "active",
    sourceKind: "",
    verificationStatus: "",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
    ...overrides,
  };
}

// Jobs for a specific user (the engine also seeds an `admin` user, so filter).
const jobsOfUser = (store: SqliteMemoryStore, kind: string, userId: string) =>
  store.listMemoryJobs({ kind } as any).filter((j: any) => j.input?.userId === userId);

test("tree_sealer fires on a settled bucket below sealThreshold, then tree_digest can chain", () => {
  const { store, engine, cleanup } = fresh("seal");
  try {
    store.createUser("u1", "br_k1", "U1", false);
    // Two mature scenes (3 records each) — well under sealThreshold (6) but at
    // the idleSealFloor (2). Without the settled-seal rule these never seal.
    for (const scene of ["Scene Alpha", "Scene Beta"]) {
      for (let i = 0; i < 3; i++) {
        store.upsertCognitive(makeRecord({ id: `${scene}-${i}`, sceneName: scene }) as any);
      }
    }

    // Pass 0: autobuild leafs both scenes (leafed > 0 → not yet settled, no seal).
    engine.enqueueScheduledMaintenance(true);
    assert.equal(jobsOfUser(store, "tree_sealer", "u1").length, 0, "no seal while the bucket is still growing");
    assert.equal((store as any).getUnsealedSceneLeaves("u1", 50).length, 2, "both scenes leafed");

    // Pass 1: no new leaf this pass (settled) + unsealed >= idleSealFloor → seal.
    engine.enqueueScheduledMaintenance(true);
    const sealJobs = jobsOfUser(store, "tree_sealer", "u1");
    assert.equal(sealJobs.length, 1, "settled bucket enqueues exactly one tree_sealer");
    assert.ok(
      Array.isArray((sealJobs[0] as any).input?.childIds) && (sealJobs[0] as any).input.childIds.length === 2,
      "tree_sealer carries the two leaf ids to seal",
    );

    // Pass 2: same bucket still pending (runner off) → idempotency dedupes.
    engine.enqueueScheduledMaintenance(true);
    assert.equal(jobsOfUser(store, "tree_sealer", "u1").length, 1, "re-enqueue of the same bucket is deduped");
  } finally {
    cleanup();
  }
});

test("benchmark_eval is auto-scheduled by maintenance (early pass) and disabled by BRAINROUTER_BENCH_SCHEDULE=off", () => {
  const { store, engine, cleanup } = fresh("bench");
  try {
    store.createUser("u1", "br_k1", "U1", false);
    engine.enqueueScheduledMaintenance(true); // pass 0
    engine.enqueueScheduledMaintenance(true); // pass 1
    assert.equal(jobsOfUser(store, "benchmark_eval", "u1").length, 0, "no benchmark before the early pass");
    engine.enqueueScheduledMaintenance(true); // pass 2 — early visibility trigger
    assert.equal(jobsOfUser(store, "benchmark_eval", "u1").length, 1, "benchmark_eval enqueued on the early pass");
  } finally {
    cleanup();
  }

  const off = fresh("bench-off");
  const restoreBench = snapshotEnv(["BRAINROUTER_BENCH_SCHEDULE"]);
  try {
    process.env.BRAINROUTER_BENCH_SCHEDULE = "off";
    off.store.createUser("u1", "br_k1", "U1", false);
    for (let i = 0; i < 4; i++) off.engine.enqueueScheduledMaintenance(true);
    assert.equal(jobsOfUser(off.store, "benchmark_eval", "u1").length, 0, "off-gate suppresses the schedule");
  } finally {
    restoreBench();
    off.cleanup();
  }
});

test("recordInlineJob leaves a done audit row for inline work", () => {
  const { store, cleanup } = fresh("inline");
  try {
    recordInlineJob(store, "source_chunker", { userId: "u1", documentIds: ["d1"] }, { chunksWritten: 3 });
    recordInlineJob(store, "blackboard_reconciler", { userId: "u1" }, { reconciled: 2, rejected: 1 });
    const chunker = store.listMemoryJobs({ kind: "source_chunker" } as any);
    const recon = store.listMemoryJobs({ kind: "blackboard_reconciler" } as any);
    assert.equal(chunker.length, 1);
    assert.equal((chunker[0] as any).status, "done", "source_chunker recorded as done");
    assert.equal((chunker[0] as any).output?.chunksWritten, 3, "summary persisted on the job output");
    assert.equal(recon.length, 1);
    assert.equal((recon[0] as any).status, "done", "blackboard_reconciler recorded as done");
  } finally {
    cleanup();
  }
});

test("idleSealFloor policy: default 2, env-overridable, min 1", () => {
  const restore = snapshotEnv(["BRAINROUTER_TREE_IDLE_SEAL_FLOOR"]);
  try {
    delete process.env.BRAINROUTER_TREE_IDLE_SEAL_FLOOR;
    assert.equal(readTreePolicy().idleSealFloor, 2, "defaults to 2");
    process.env.BRAINROUTER_TREE_IDLE_SEAL_FLOOR = "4";
    assert.equal(readTreePolicy().idleSealFloor, 4, "honors a valid override");
    process.env.BRAINROUTER_TREE_IDLE_SEAL_FLOOR = "0"; // below min → falls back
    assert.equal(readTreePolicy().idleSealFloor, 2, "rejects < 1 and falls back to default");
  } finally {
    restore();
  }
});
