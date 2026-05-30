import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * 0.4.3 (MEM-9) — benchmark_eval self-retrieval harness, end to end on a real
 * store. Uses an explicit baseDir so the summary lands in a temp dir, not the
 * developer's ~/.brainrouter.
 */

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-bench-${label}-`));
  const prevRunner = process.env.BRAINROUTER_JOB_RUNNER;
  process.env.BRAINROUTER_JOB_RUNNER = "off";
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store, dir, engine,
    cleanup: () => {
      if (prevRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevRunner;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inRange = (n: number) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

test("benchmark: insufficient data (< 3 records) → empty stats, passed, no file", async () => {
  const { engine, cleanup } = fresh("few");
  try {
    engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "only one record about the parser module" });
    const r = await engine.runRetrievalBenchmark("u1", { sampleSize: 10 });
    assert.equal(r.sampled, 1);
    assert.deepEqual(r.statsByMode, {});
    assert.equal(r.passed, true);
    assert.equal(r.summaryPath, null);
  } finally {
    cleanup();
  }
});

test("benchmark: runs baseline + lexmmr on real records, valid metrics, writes a summary", async () => {
  const { engine, dir, cleanup } = fresh("run");
  try {
    const facts = [
      "the recall pipeline fuses FTS and vector hits with reciprocal rank fusion",
      "the blackboard reconciler dedups staged candidates before they commit",
      "the memory tree seals buckets of leaves into summarized parent nodes",
      "vault export writes a redacted markdown mirror with a hash ledger",
      "the source chunker splits transcripts into citable token-bounded chunks",
    ];
    for (const content of facts) engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content });

    const benchDir = join(dir, "bench-out");
    const r = await engine.runRetrievalBenchmark("u1", { sampleSize: 5, baseDir: benchDir });

    assert.equal(r.sampled, 5);
    assert.ok(r.statsByMode.baseline, "baseline mode present");
    assert.ok(r.statsByMode.lexmmr, "lexmmr mode present");
    for (const mode of ["baseline", "lexmmr"] as const) {
      const s = r.statsByMode[mode] as unknown as Record<string, number>;
      for (const k of ["recall_any_at_5", "recall_any_at_10", "recall_any_at_20", "ndcg_at_10", "mrr"]) {
        assert.ok(inRange(s[k]), `${mode}.${k} must be in [0,1], got ${s[k]}`);
      }
    }
    assert.ok(r.summaryPath && existsSync(r.summaryPath), "summary markdown written to baseDir");
    assert.equal(typeof r.passed, "boolean");

    // The env knobs the bench toggles must be restored afterwards.
    assert.equal(process.env.BRAINROUTER_RECALL_TOP_RESULTS, undefined, "TOP_RESULTS restored");
    assert.equal(process.env.BRAINROUTER_RECALL_DIVERSITY, undefined, "DIVERSITY restored");
  } finally {
    cleanup();
  }
});
