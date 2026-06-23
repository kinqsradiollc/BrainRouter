import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestEngine } from "./helpers/pgTestStore.js";

/**
 * 0.4.3 (MEM-9) — benchmark_eval self-retrieval harness, end to end on a real
 * store. Uses an explicit baseDir so the summary lands in a temp dir, not the
 * developer's ~/.brainrouter.
 */

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-bench-`));
  // Hermetic env: the engine constructor reads the reranker/judge knobs from
  // process.env, so a developer machine with a live reranker endpoint or
  // BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true would otherwise flip the bench
  // into running those modes against real services (skippedModes assertions
  // fail + the test hits live endpoints). Snapshot + clear, restore in cleanup.
  // (createTestEngine handles BRAINROUTER_JOB_RUNNER; the reranker/judge keys
  // are still ours to scrub.)
  const HERMETIC_KEYS = [
    "BRAINROUTER_RERANKER_ENDPOINT",
    "BRAINROUTER_RERANKER_API_KEY",
    "BRAINROUTER_RERANKER_MODEL",
    "BRAINROUTER_RELEVANCE_JUDGE_ENABLED",
  ] as const;
  const prevEnv = new Map<string, string | undefined>(HERMETIC_KEYS.map((k) => [k, process.env[k]]));
  for (const k of HERMETIC_KEYS) delete process.env[k];
  const { store, engine, cleanup: cleanupEngine } = await createTestEngine();
  return {
    store, dir, engine,
    cleanup: async () => {
      for (const [k, v] of prevEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await cleanupEngine();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inRange = (n: number) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

test("benchmark: insufficient data (< 3 records) → empty stats, passed, no file", async () => {
  const { engine, cleanup } = await fresh();
  try {
    await engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "only one record about the parser module" });
    const r = await engine.runRetrievalBenchmark("u1", { sampleSize: 10 });
    assert.equal(r.sampled, 1);
    assert.deepEqual(r.statsByMode, {});
    assert.equal(r.passed, true);
    assert.equal(r.summaryPath, null);
  } finally {
    await cleanup();
  }
});

test("benchmark: runs baseline + lexmmr on real records, valid metrics, writes a summary", async () => {
  const { engine, dir, cleanup } = await fresh();
  // MEM-19: capture the recall knobs to prove the bench no longer mutates them.
  const top0 = process.env.BRAINROUTER_RECALL_TOP_RESULTS;
  const div0 = process.env.BRAINROUTER_RECALL_DIVERSITY;
  try {
    const facts = [
      "the recall pipeline fuses FTS and vector hits with reciprocal rank fusion",
      "the blackboard reconciler dedups staged candidates before they commit",
      "the memory tree seals buckets of leaves into summarized parent nodes",
      "vault export writes a redacted markdown mirror with a hash ledger",
      "the source chunker splits transcripts into citable token-bounded chunks",
    ];
    for (const content of facts) await engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content });

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

    // MEM-19: mode config is passed to recall per-call, so the bench must NOT
    // mutate these process.env knobs (the old toggle approach leaked '20').
    assert.equal(process.env.BRAINROUTER_RECALL_TOP_RESULTS, top0, "TOP_RESULTS untouched");
    assert.equal(process.env.BRAINROUTER_RECALL_DIVERSITY, div0, "DIVERSITY untouched");
    // No reranker/judge configured in tests → reported as skipped, not faked as baseline.
    assert.deepEqual(
      [...r.skippedModes].sort(),
      ["judge (relevance judge disabled)", "rerank (no reranker configured)"],
    );
  } finally {
    cleanup();
  }
});

test("MEM-25 retrieval benchmark reports per-mode latency", async () => {
  const { engine, cleanup } = await fresh();
  try {
    for (let i = 0; i < 4; i++) {
      await engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: `fact ${i} about the recall pipeline, chunking, and the blackboard reconciler` });
    }
    const r = await engine.runRetrievalBenchmark("u1", { sampleSize: 4 });
    assert.ok(r.latencyMsByMode && typeof r.latencyMsByMode.baseline === "number", "baseline latency present");
    assert.ok(r.latencyMsByMode.baseline >= 0, "non-negative latency");
  } finally {
    await cleanup();
  }
});

test("MEM-25 code-recall benchmark scores symbol isolation + writes a numbers file", async () => {
  const { engine, dir, cleanup } = await fresh();
  try {
    const r = engine.runCodeChunkBenchmark({ baseDir: join(dir, "cr") });
    assert.equal(r.expectedSymbols, 8);
    assert.ok(r.symbolRecall >= 0.875, `symbol recall ${r.symbolRecall}`);
    assert.ok(r.summaryPath && existsSync(r.summaryPath), "code-recall numbers file written");
  } finally {
    await cleanup();
  }
});
