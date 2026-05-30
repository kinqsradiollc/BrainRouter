import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * 0.4.3 (MEM-10) — auto-scheduling of the maintenance depth agents.
 * engine.enqueueScheduledMaintenance() is the per-tick hook: it throttles to
 * ~5 min, enqueues vault_exporter ~hourly + blackboard_reconciler only when a
 * user has pending candidates, and is gated by BRAINROUTER_JOB_MAINTENANCE.
 */

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-maint-${label}-`));
  const prevRunner = process.env.BRAINROUTER_JOB_RUNNER;
  process.env.BRAINROUTER_JOB_RUNNER = "off"; // don't start a live timer in the test
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store,
    engine,
    cleanup: () => {
      if (prevRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevRunner;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const pendingJobs = (store: SqliteMemoryStore, kind: string, userId: string) =>
  store.listMemoryJobs({ kind, status: ["pending", "running"] }).filter((j: any) => j.input?.userId === userId);

test("maintenance: vault on pass 0, blackboard only when pending, throttle + off-gate", () => {
  const { store, engine, cleanup } = fresh("core");
  try {
    store.createUser("u1", "br_k1", "U1", false);

    // Pass 0 (forced): no pending blackboard → vault enqueued for u1, no reconciler.
    const r0 = engine.enqueueScheduledMaintenance(true);
    assert.ok(r0.enqueued.vault_exporter >= 1, "vault enqueued on pass 0");
    assert.equal(r0.enqueued.blackboard_reconciler, 0, "no pending blackboard → not enqueued");
    assert.equal(pendingJobs(store, "vault_exporter", "u1").length, 1, "u1 has a pending vault job");
    assert.equal(pendingJobs(store, "blackboard_reconciler", "u1").length, 0);

    // Throttle: an immediate, non-forced call does nothing.
    assert.equal(engine.enqueueScheduledMaintenance(false).skipped, true, "throttled within the interval");

    // Stage a pending candidate → next forced pass enqueues the reconciler for u1.
    engine.stageBlackboardCandidates("u1", [{ score: 0.9, candidate: { content: "fact A", type: "codebase_fact" } }]);
    const r1 = engine.enqueueScheduledMaintenance(true); // pass 1
    assert.ok(r1.enqueued.blackboard_reconciler >= 1, "pending → reconciler enqueued");
    assert.equal(r1.enqueued.vault_exporter, 0, "pass 1 (1 % 12 != 0) → no vault this pass");
    assert.equal(pendingJobs(store, "blackboard_reconciler", "u1").length, 1, "u1 has a pending reconciler job");

    // Off-gate.
    const prev = process.env.BRAINROUTER_JOB_MAINTENANCE;
    process.env.BRAINROUTER_JOB_MAINTENANCE = "off";
    try {
      assert.equal(engine.enqueueScheduledMaintenance(true).skipped, true, "off-gate skips even when forced");
    } finally {
      if (prev === undefined) delete process.env.BRAINROUTER_JOB_MAINTENANCE;
      else process.env.BRAINROUTER_JOB_MAINTENANCE = prev;
    }
  } finally {
    cleanup();
  }
});

test("maintenance: enqueues vault for each active user; dedupes an in-flight job", () => {
  const { store, engine, cleanup } = fresh("multi");
  try {
    store.createUser("u1", "br_k1", "U1", false);
    store.createUser("u2", "br_k2", "U2", false);

    const r = engine.enqueueScheduledMaintenance(true); // pass 0 → vault for each
    assert.ok(r.enqueued.vault_exporter >= 2, "vault enqueued for each user");
    assert.equal(pendingJobs(store, "vault_exporter", "u1").length, 1);
    assert.equal(pendingJobs(store, "vault_exporter", "u2").length, 1);
  } finally {
    cleanup();
  }
});
