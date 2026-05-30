import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { store: SqliteMemoryStore; engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-bb-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, engine: new MemoryEngine(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-4 stage → reconcile → commit → cognitive record + provenance link", () => {
  const { store, engine, cleanup } = fresh("commit");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "hbb", title: "t" });
    const [chunk] = store.addSourceChunks(doc.id, [{ content: "source text", tokenCount: 2 }]);

    const staged = engine.stageBlackboardCandidates("u1", [
      { sourceChunkId: chunk.id, score: 0.9, candidate: { content: "Important fact A", type: "codebase_fact" } },
      { score: 0.5, candidate: { content: "important   fact a", type: "codebase_fact" } }, // duplicate (lower score)
      { score: 0.1, candidate: { content: "weak fact", type: "codebase_fact" } },           // below threshold
    ]);
    assert.equal(staged.length, 3);

    const rec = engine.reconcilePendingBlackboard("u1");
    assert.deepEqual({ r: rec.reconciled, d: rec.duplicate, x: rec.rejected }, { r: 1, d: 1, x: 1 });

    const reconciled = engine.reviewBlackboard("u1", "reconciled");
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].sourceChunkId, chunk.id, "the source-bearing, higher-scored candidate won");

    const result = engine.commitBlackboardItem("u1", reconciled[0].id);
    assert.equal(result.committed, true);
    assert.ok(result.recordId);

    const committed = engine.reviewBlackboard("u1", "committed");
    assert.equal(committed[0].committedRecordId, result.recordId);
    assert.ok(store.getMemoryById("u1", result.recordId!), "cognitive record was created");
    assert.equal(store.getRecordSourceChunks(result.recordId!)[0]?.id, chunk.id, "provenance linked on commit");
  } finally { cleanup(); }
});

test("MEM-4 commit refuses a non-reconciled item; reject works", () => {
  const { engine, cleanup } = fresh("guard");
  try {
    const [staged] = engine.stageBlackboardCandidates("u1", [{ score: 0.9, candidate: { content: "x fact", type: "codebase_fact" } }]);
    const blocked = engine.commitBlackboardItem("u1", staged.id);
    assert.equal(blocked.committed, false, "pending items can't commit before reconcile");

    assert.equal(engine.rejectBlackboardItem("u1", staged.id), true);
    assert.equal(engine.reviewBlackboard("u1", "rejected").length, 1);
    assert.equal(engine.reviewBlackboard("u1", "pending").length, 0);
  } finally { cleanup(); }
});
