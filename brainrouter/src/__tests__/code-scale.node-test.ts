import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "../memory/engine.js";
import { createTestEngine } from "./helpers/pgTestStore.js";

/**
 * CODE-SCALE (0.4.5) — end-to-end repo-scale find_related retrieval benchmark
 * on a real store. Ingests the labelled fixture, runs find_related per seed,
 * and asserts the ranking actually surfaces the in-cluster relevant files.
 */
async function fresh(): Promise<{ engine: MemoryEngine; dir: string; cleanup: () => Promise<void> }> {
  // The DB lives in Postgres now; this temp dir is only the benchmark fixture's
  // baseDir (where the labelled repo + summary file are written).
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-codescale-"));
  const { engine, cleanup } = await createTestEngine();
  return {
    engine, dir,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
      await cleanup();
    },
  };
}

test("code-scale: find_related surfaces in-cluster files at repo scale", async () => {
  const { engine, dir, cleanup } = await fresh();
  try {
    const r = await engine.runCodeScaleBenchmark({ baseDir: dir, k: 10, clusters: 6, perCluster: 5 });

    assert.equal(r.queries, 6, "one query per cluster");
    // The fixture wires each cluster as an import chain + shared lexical prefix,
    // so a healthy retriever recalls (nearly) all relevant files and ranks a
    // relevant hit first.
    assert.ok(r.recallAtK >= 0.9, `recall@10 should be high, got ${r.recallAtK}`);
    assert.ok(r.mrr >= 0.9, `MRR should be high, got ${r.mrr}`);
    assert.ok(r.ndcgAtK >= 0.9, `nDCG@10 should be high, got ${r.ndcgAtK}`);

    // Metrics stay in range.
    for (const v of [r.recallAtK, r.precisionAtK, r.mrr, r.ndcgAtK]) {
      assert.ok(v >= 0 && v <= 1, `metric in [0,1], got ${v}`);
    }

    // Token-efficiency: the top-k chunks should cost a fraction of a full dump.
    assert.ok(typeof r.tokenEfficiency === "number" && r.tokenEfficiency > 0 && r.tokenEfficiency < 1,
      `token efficiency in (0,1), got ${r.tokenEfficiency}`);

    // A summary file was written and contains the headline.
    assert.ok(r.summaryPath && existsSync(r.summaryPath), "summary written");
    assert.match(readFileSync(r.summaryPath!, "utf8"), /recall@10/);
  } finally {
    await cleanup();
  }
});

test("code-scale: bench writes into an isolated user, not real memory", async () => {
  const { engine, dir, cleanup } = await fresh();
  try {
    await engine.runCodeScaleBenchmark({ baseDir: dir, clusters: 2, perCluster: 3 });
    // The default real users see nothing from the bench.
    const real = await engine.findRelatedChunks("default", { filePath: "src/auth/auth_mod0.ts", line: 5 });
    assert.equal(real.found, false, "bench fixture is not visible to the default user");
  } finally {
    await cleanup();
  }
});
