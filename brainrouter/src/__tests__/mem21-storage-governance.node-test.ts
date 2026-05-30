import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * MEM-21 (0.4.4) — storage-governance dry-run over the depth tables, on a real
 * store. The key invariant: only source chunks NOT cited by a live memory's
 * provenance count as reclaimable.
 */

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-gov-${label}-`));
  const prevRunner = process.env.BRAINROUTER_JOB_RUNNER;
  process.env.BRAINROUTER_JOB_RUNNER = "off";
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store, engine,
    cleanup: () => {
      if (prevRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevRunner;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("MEM-21 getStorageGovernanceStats + plan: only orphaned chunks are reclaimable", () => {
  const { store, engine, cleanup } = fresh("orphan");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h1", title: "t" });
    const chunks = store.addSourceChunks(doc.id, [
      { content: "alpha alpha alpha", tokenCount: 3 },
      { content: "beta beta", tokenCount: 2 },
      { content: "gamma", tokenCount: 1 },
    ]);
    // One cognitive record cites the first chunk → that chunk is NOT reclaimable.
    const rec = engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "a fact" });
    store.linkRecordSources("u1", rec.id, [chunks[0].id]);
    store.appendTreeNode("u1", { kind: "topic", summaryMd: "a topic summary", sourceChunkIds: [chunks[0].id] });

    const stats = store.getStorageGovernanceStats("u1");
    assert.equal(stats.sourceChunks.count, 3);
    assert.equal(stats.sourceChunks.orphanCount, 2, "2 of 3 chunks are uncited (orphaned)");
    assert.equal(stats.sourceDocuments, 1);
    assert.equal(stats.treeNodes.count, 1);
    assert.ok(stats.treeNodes.chars > 0);

    const plan = engine.governanceStoragePlan("u1");
    const chunkClass = plan.classes.find((c) => c.class === "source_chunks")!;
    assert.equal(chunkClass.count, 3);
    // reclaimable = orphan chars only (the cited chunk's chars are excluded).
    assert.equal(chunkClass.reclaimableChars, stats.sourceChunks.orphanChars);
    assert.ok(chunkClass.estimatedChars > chunkClass.reclaimableChars, "cited chunk's chars are not reclaimable");
    const treeClass = plan.classes.find((c) => c.class === "tree_nodes")!;
    assert.equal(treeClass.reclaimableChars, 0, "tree summaries are not auto-reclaimed");
  } finally {
    cleanup();
  }
});
