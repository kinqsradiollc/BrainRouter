import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

/**
 * MEM-17 (0.4.4) — recall expansion refs: the store lookup that maps a source
 * chunk back to a covering memory-tree node (the `treeNodeId` handle on recall
 * hits). Real sqlite so the LIKE-escape is exercised against actual rows.
 */

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem17-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-17 getTreeNodeIdByChunkId — exact match; underscore is not a LIKE wildcard", () => {
  const { store, cleanup } = fresh("treelookup");
  try {
    const a = store.appendTreeNode("u1", { kind: "source", summaryMd: "A", sourceChunkIds: ["chunk_aaa"] });
    // Newer node whose id would be matched by an UN-escaped `_` wildcard against "chunk_aaa".
    const b = store.appendTreeNode("u1", { kind: "source", summaryMd: "B", sourceChunkIds: ["chunkXaaa"] });

    // Escaping makes `_` literal, so the query resolves to its own node — not the newer look-alike.
    assert.equal(store.getTreeNodeIdByChunkId("u1", "chunk_aaa"), a.id);
    assert.equal(store.getTreeNodeIdByChunkId("u1", "chunkXaaa"), b.id);

    // Unknown chunk and wrong user → null.
    assert.equal(store.getTreeNodeIdByChunkId("u1", "chunk_zzz"), null);
    assert.equal(store.getTreeNodeIdByChunkId("u2", "chunk_aaa"), null);
  } finally {
    cleanup();
  }
});

test("MEM-17 getTreeNodeIdByChunkId returns the most recent covering node", () => {
  const { store, cleanup } = fresh("recent");
  try {
    store.appendTreeNode("u1", { kind: "source", summaryMd: "old", sourceChunkIds: ["chunk_shared"] });
    const newer = store.appendTreeNode("u1", { kind: "topic", summaryMd: "new", sourceChunkIds: ["chunk_shared", "chunk_other"] });
    assert.equal(store.getTreeNodeIdByChunkId("u1", "chunk_shared"), newer.id);
  } finally {
    cleanup();
  }
});
