import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";

test("MEM-5 append leaves → summarize bucket → walk roots and drill", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const a = (await engine.appendTreeLeaf("u1", "source", "Leaf about auth", ["c1", "c2"], 1))!;
    const b = (await engine.appendTreeLeaf("u1", "source", "Leaf about routing", ["c2", "c3"], 2))!;
    assert.equal(a.level, 0);

    // before sealing, both leaves are roots (no parent)
    assert.equal((await engine.treeWalk("u1", undefined, "source")).roots!.length, 2);

    const parent = (await engine.summarizeBucket("u1", [a.id, b.id], "topic"))!;
    assert.equal(parent.level, 1, "parent one level above leaves");
    assert.deepEqual(parent.sourceChunkIds, ["c1", "c2", "c3"], "aggregated + de-duped chunk ids");
    assert.equal(parent.heatScore, 3, "heat summed");
    assert.match(parent.summaryMd, /Leaf about auth/);

    // now the only "topic" root is the parent; drilling it returns the two leaves
    const roots = (await engine.treeWalk("u1", undefined, "topic")).roots!;
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, parent.id);
    const drill = await engine.treeWalk("u1", parent.id);
    assert.equal(drill.children.length, 2);
    assert.deepEqual(drill.children.map((c) => c.id).sort(), [a.id, b.id].sort());
  } finally { await cleanup(); }
});

test("MEM-5 summarizing seals the children", async () => {
  const { store, engine, cleanup } = await createTestEngine();
  try {
    const leaf = (await engine.appendTreeLeaf("u1", "source", "x", []))!;
    assert.equal((await store.getTreeNode(leaf.id))!.sealedAt, null);
    await engine.summarizeBucket("u1", [leaf.id], "topic");
    assert.ok((await store.getTreeNode(leaf.id))!.sealedAt, "child sealed after roll-up");
  } finally { await cleanup(); }
});
