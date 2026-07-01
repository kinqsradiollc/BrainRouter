import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
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

// Regression for the dropped `rowid DESC` tiebreak: when two covering nodes
// share an identical created_at (same-millisecond appends — the CI-only flake),
// the query must still return the newest (highest seq), not an arbitrary
// heap-ordered row. We force the tie with a raw UPDATE so this is deterministic
// on every machine, not just slow ones.
test("MEM-17 getTreeNodeIdByChunkId breaks created_at ties by insertion order (seq)", async () => {
  const { store, url, cleanup } = await createTestStore();
  const client = new pg.Client({ connectionString: url });
  try {
    const older = await store.appendTreeNode("u1", { kind: "source", summaryMd: "old", sourceChunkIds: ["chunk_tie"] });
    const newer = await store.appendTreeNode("u1", { kind: "topic", summaryMd: "new", sourceChunkIds: ["chunk_tie"] });

    // Collapse both rows onto the SAME created_at so only the seq tiebreak decides.
    await client.connect();
    await client.query("UPDATE memory_tree_nodes SET created_at = $1 WHERE user_id = 'u1'", ["2026-01-01T00:00:00.000Z"]);

    // seq is assigned in insertion order, so `newer` (inserted second) wins.
    assert.equal(await store.getTreeNodeIdByChunkId("u1", "chunk_tie"), newer.id);
    assert.notEqual(newer.id, older.id);
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});
