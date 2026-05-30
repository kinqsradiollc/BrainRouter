import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * 0.4.3 (MEM-10) — scene-tree autobuild (the tree_sealer auto-trigger source).
 * Leaves are built over cognitive records grouped by scene; once enough unsealed
 * scene-leaves accumulate, the maintenance pass enqueues tree_sealer.
 * (upsertEngineeringMemory derives sceneName from activeSkill, so activeSkill is
 * how the test seeds distinct scenes.)
 */

// MEM-20: the engine imports `dotenv/config`, so a developer's local
// brainrouter/.env (which may set BRAINROUTER_TREE_AUTOBUILD=off, custom
// thresholds, etc.) is loaded into process.env before these tests run and would
// otherwise make the autobuild a no-op. Neutralize the tree knobs per test so we
// exercise the documented defaults regardless of the environment.
const TREE_ENV = [
  "BRAINROUTER_TREE_AUTOBUILD",
  "BRAINROUTER_TREE_MIN_SCENE_RECORDS",
  "BRAINROUTER_TREE_LEAF_PER_PASS",
  "BRAINROUTER_TREE_SEAL_THRESHOLD",
];

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-tree-${label}-`));
  const prevRunner = process.env.BRAINROUTER_JOB_RUNNER;
  process.env.BRAINROUTER_JOB_RUNNER = "off";
  const prevTree = TREE_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of TREE_ENV) delete process.env[k];
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store, engine,
    cleanup: () => {
      if (prevRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevRunner;
      for (const [k, v] of prevTree) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seed `scenes` mature scenes (3 records each) + one trivial scene (1 record). */
function seedScenes(engine: MemoryEngine, store: SqliteMemoryStore, userId: string, scenes: number) {
  // The maintenance pass iterates registered users (store.listUsers), so the
  // record owner must exist as a user — in production records always do.
  store.createUser(userId, `br_${userId}`, userId, false);
  for (let s = 0; s < scenes; s++) {
    for (let r = 0; r < 3; r++) {
      engine.upsertEngineeringMemory({ userId, type: "codebase_fact", content: `scene ${s} record ${r}: a fact about topic ${s}`, activeSkill: `scene${s}` });
    }
  }
  engine.upsertEngineeringMemory({ userId, type: "codebase_fact", content: "a lone trivial fact", activeSkill: "trivialScene" });
}

test("autobuildSceneTree: leafs mature scenes (capped/pass), idempotent, skips trivial, yields a sealable bucket", () => {
  const { store, engine, cleanup } = fresh("build");
  try {
    seedScenes(engine, store, "u1", 6); // 6 mature scenes + 1 trivial

    // Pass 1: capped at TREE_LEAF_PER_PASS (5); not enough leaves yet to seal.
    const p1 = engine.autobuildSceneTree("u1");
    assert.equal(p1.leafed, 5, "first pass leafs up to the per-pass cap");
    assert.equal(p1.sealableBucket, null, "5 leaves < seal threshold");

    // Pass 2: leafs the 6th mature scene (trivial scene is < 3 records → skipped).
    const p2 = engine.autobuildSceneTree("u1");
    assert.equal(p2.leafed, 1, "second pass leafs the remaining mature scene");
    assert.ok(p2.sealableBucket && p2.sealableBucket.length === 6, "6 unsealed leaves → sealable bucket");

    // Idempotent: a third pass re-leafs nothing.
    assert.equal(engine.autobuildSceneTree("u1").leafed, 0, "no re-leafing already-leafed scenes");

    const leafKeys = (store as unknown as { getSceneLeafKeys(u: string): string[] }).getSceneLeafKeys("u1");
    assert.equal(leafKeys.length, 6, "exactly one leaf per mature scene");
    assert.ok(!leafKeys.includes("trivialScene engineering"), "trivial scene was not leafed");
  } finally {
    cleanup();
  }
});

test("maintenance enqueues tree_sealer once a scene-leaf bucket is full", () => {
  const { store, engine, cleanup } = fresh("maint");
  try {
    seedScenes(engine, store, "u1", 6);
    // Two forced maintenance passes leaf all 6 (5 + 1) and then enqueue tree_sealer.
    engine.enqueueScheduledMaintenance(true);
    const r2 = engine.enqueueScheduledMaintenance(true);
    assert.ok(r2.enqueued.tree_sealer >= 1, "tree_sealer enqueued when the bucket fills");

    const jobs = store.listMemoryJobs({ kind: "tree_sealer", status: ["pending", "running"] }) as Array<{ input?: { childIds?: string[]; kind?: string } }>;
    assert.equal(jobs.length, 1, "one tree_sealer job");
    assert.ok(Array.isArray(jobs[0].input?.childIds) && jobs[0].input!.childIds!.length === 6, "job carries the 6-leaf bucket");
    assert.equal(jobs[0].input?.kind, "global", "seals into a global parent");
  } finally {
    cleanup();
  }
});

test("autobuildSceneTree is a no-op when BRAINROUTER_TREE_AUTOBUILD=off", () => {
  const { store, engine, cleanup } = fresh("gate");
  const prev = process.env.BRAINROUTER_TREE_AUTOBUILD;
  process.env.BRAINROUTER_TREE_AUTOBUILD = "off";
  try {
    seedScenes(engine, store, "u1", 6);
    assert.deepEqual(engine.autobuildSceneTree("u1"), { leafed: 0, sealableBucket: null });
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_TREE_AUTOBUILD;
    else process.env.BRAINROUTER_TREE_AUTOBUILD = prev;
    cleanup();
  }
});
