import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";

/**
 * MEM-17 (0.4.4) — recall expansion refs: the store lookup that maps a source
 * chunk back to a covering memory-tree node (the `treeNodeId` handle on recall
 * hits). Real Postgres so the LIKE-escape is exercised against actual rows.
 */

test("MEM-17 getTreeNodeIdByChunkId — exact match; underscore is not a LIKE wildcard", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const a = await store.appendTreeNode("u1", { kind: "source", summaryMd: "A", sourceChunkIds: ["chunk_aaa"] });
    // Newer node whose id would be matched by an UN-escaped `_` wildcard against "chunk_aaa".
    const b = await store.appendTreeNode("u1", { kind: "source", summaryMd: "B", sourceChunkIds: ["chunkXaaa"] });

    // Escaping makes `_` literal, so the query resolves to its own node — not the newer look-alike.
    assert.equal(await store.getTreeNodeIdByChunkId("u1", "chunk_aaa"), a.id);
    assert.equal(await store.getTreeNodeIdByChunkId("u1", "chunkXaaa"), b.id);

    // Unknown chunk and wrong user → null.
    assert.equal(await store.getTreeNodeIdByChunkId("u1", "chunk_zzz"), null);
    assert.equal(await store.getTreeNodeIdByChunkId("u2", "chunk_aaa"), null);
  } finally {
    await cleanup();
  }
});

test("MEM-17 getTreeNodeIdByChunkId returns the most recent covering node", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.appendTreeNode("u1", { kind: "source", summaryMd: "old", sourceChunkIds: ["chunk_shared"] });
    const newer = await store.appendTreeNode("u1", { kind: "topic", summaryMd: "new", sourceChunkIds: ["chunk_shared", "chunk_other"] });
    assert.equal(await store.getTreeNodeIdByChunkId("u1", "chunk_shared"), newer.id);
  } finally {
    await cleanup();
  }
});
