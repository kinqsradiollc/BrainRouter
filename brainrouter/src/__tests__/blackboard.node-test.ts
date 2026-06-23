import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { asyncify } from "../memory/store/asyncify.js";

function fresh(label: string): { store: SqliteMemoryStore; engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-bb-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, engine: new MemoryEngine(asyncify(store)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-4 stage → reconcile → commit → cognitive record + provenance link", async () => {
  const { store, engine, cleanup } = fresh("commit");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "hbb", title: "t" });
    const [chunk] = store.addSourceChunks(doc.id, [{ content: "source text", tokenCount: 2 }]);

    const staged = await engine.stageBlackboardCandidates("u1", [
      { sourceChunkId: chunk.id, score: 0.9, candidate: { content: "Important fact A", type: "codebase_fact" } },
      { score: 0.5, candidate: { content: "important   fact a", type: "codebase_fact" } }, // duplicate (lower score)
      { score: 0.1, candidate: { content: "weak fact", type: "codebase_fact" } },           // below threshold
    ]);
    assert.equal(staged.length, 3);

    const rec = await engine.reconcilePendingBlackboard("u1");
    assert.deepEqual({ r: rec.reconciled, d: rec.duplicate, x: rec.rejected }, { r: 1, d: 1, x: 1 });

    const reconciled = await engine.reviewBlackboard("u1", "reconciled");
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].sourceChunkId, chunk.id, "the source-bearing, higher-scored candidate won");

    const result = await engine.commitBlackboardItem("u1", reconciled[0].id);
    assert.equal(result.committed, true);
    assert.ok(result.recordId);

    const committed = await engine.reviewBlackboard("u1", "committed");
    assert.equal(committed[0].committedRecordId, result.recordId);
    assert.ok(store.getMemoryById("u1", result.recordId!), "cognitive record was created");
    assert.equal(store.getRecordSourceChunks("u1", result.recordId!)[0]?.id, chunk.id, "provenance linked on commit");
  } finally { cleanup(); }
});

test("MEM-4 commit refuses a non-reconciled item; reject works", async () => {
  const { engine, cleanup } = fresh("guard");
  try {
    const [staged] = await engine.stageBlackboardCandidates("u1", [{ score: 0.9, candidate: { content: "x fact", type: "codebase_fact" } }]);
    const blocked = await engine.commitBlackboardItem("u1", staged.id);
    assert.equal(blocked.committed, false, "pending items can't commit before reconcile");

    assert.equal(await engine.rejectBlackboardItem("u1", staged.id), true);
    assert.equal((await engine.reviewBlackboard("u1", "rejected")).length, 1);
    assert.equal((await engine.reviewBlackboard("u1", "pending")).length, 0);
  } finally { cleanup(); }
});

test("BLACKBOARD-REVIEW-UX restore: a rejected item returns to pending for re-review", async () => {
  const { engine, cleanup } = fresh("restore");
  try {
    const [staged] = await engine.stageBlackboardCandidates("u1", [{ score: 0.9, candidate: { content: "restorable fact", type: "codebase_fact" } }]);
    assert.equal(await engine.rejectBlackboardItem("u1", staged.id), true);
    assert.equal((await engine.reviewBlackboard("u1", "rejected")).length, 1);

    const res = await engine.restoreBlackboardItem("u1", staged.id);
    assert.equal(res.restored, true);
    assert.equal(res.status, "pending");
    assert.equal((await engine.reviewBlackboard("u1", "rejected")).length, 0);
    assert.equal((await engine.reviewBlackboard("u1", "pending")).length, 1, "restored item is pending again");
  } finally { cleanup(); }
});

test("BLACKBOARD-REVIEW-UX restore: only rejected/duplicate are restorable; pending + unknown are no-ops", async () => {
  const { engine, cleanup } = fresh("restore-guard");
  try {
    const [staged] = await engine.stageBlackboardCandidates("u1", [{ score: 0.9, candidate: { content: "pending fact", type: "codebase_fact" } }]);
    // A pending item is not "dropped" — restore should refuse and explain.
    const pending = await engine.restoreBlackboardItem("u1", staged.id);
    assert.equal(pending.restored, false);
    assert.match(pending.reason ?? "", /rejected\/duplicate/);
    // Unknown id.
    assert.equal((await engine.restoreBlackboardItem("u1", "no-such-id")).restored, false);
    // Wrong user can't restore another user's item.
    await engine.rejectBlackboardItem("u1", staged.id);
    assert.equal((await engine.restoreBlackboardItem("other-user", staged.id)).restored, false);
  } finally { cleanup(); }
});
