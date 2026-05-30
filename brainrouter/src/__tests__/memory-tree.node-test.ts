import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { store: SqliteMemoryStore; engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-tree-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, engine: new MemoryEngine(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-5 append leaves → summarize bucket → walk roots and drill", () => {
  const { engine, cleanup } = fresh("walk");
  try {
    const a = engine.appendTreeLeaf("u1", "source", "Leaf about auth", ["c1", "c2"], 1)!;
    const b = engine.appendTreeLeaf("u1", "source", "Leaf about routing", ["c2", "c3"], 2)!;
    assert.equal(a.level, 0);

    // before sealing, both leaves are roots (no parent)
    assert.equal(engine.treeWalk("u1", undefined, "source").roots!.length, 2);

    const parent = engine.summarizeBucket("u1", [a.id, b.id], "topic")!;
    assert.equal(parent.level, 1, "parent one level above leaves");
    assert.deepEqual(parent.sourceChunkIds, ["c1", "c2", "c3"], "aggregated + de-duped chunk ids");
    assert.equal(parent.heatScore, 3, "heat summed");
    assert.match(parent.summaryMd, /Leaf about auth/);

    // now the only "topic" root is the parent; drilling it returns the two leaves
    const roots = engine.treeWalk("u1", undefined, "topic").roots!;
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, parent.id);
    const drill = engine.treeWalk("u1", parent.id);
    assert.equal(drill.children.length, 2);
    assert.deepEqual(drill.children.map((c) => c.id).sort(), [a.id, b.id].sort());
  } finally { cleanup(); }
});

test("MEM-5 summarizing seals the children", () => {
  const { store, engine, cleanup } = fresh("seal");
  try {
    const leaf = engine.appendTreeLeaf("u1", "source", "x", [])!;
    assert.equal(store.getTreeNode(leaf.id)!.sealedAt, null);
    engine.summarizeBucket("u1", [leaf.id], "topic");
    assert.ok(store.getTreeNode(leaf.id)!.sealedAt, "child sealed after roll-up");
  } finally { cleanup(); }
});
