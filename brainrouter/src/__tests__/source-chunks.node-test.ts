import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-source-chunks-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("0.4.3 source_documents: create + round-trip + idempotent by (user, hash)", () => {
  const { store, cleanup } = freshDb("docs");
  try {
    const doc = store.createSourceDocument({
      userId: "u1", workspaceTag: "ws16", kind: "tool_output",
      uri: "npm test", hash: "h1", title: "test run", metadata: { exit: 1 },
    });
    assert.ok(doc.id);
    const got = store.getSourceDocument(doc.id);
    assert.equal(got?.uri, "npm test");
    assert.equal(got?.kind, "tool_output");
    assert.deepEqual(got?.metadata, { exit: 1 });
    // re-ingest identical content (same user+hash) returns the SAME row, no dup
    const again = store.createSourceDocument({ userId: "u1", kind: "tool_output", uri: "npm test", hash: "h1", title: "test run", workspaceTag: "ws16" });
    assert.equal(again.id, doc.id);
    // different user with same hash is a distinct doc
    const other = store.createSourceDocument({ userId: "u2", kind: "tool_output", uri: "npm test", hash: "h1", title: "x", workspaceTag: null });
    assert.notEqual(other.id, doc.id);
  } finally {
    cleanup();
  }
});

test("0.4.3 source_chunks: append assigns ordinals + sha1 hash; fetch ordered", () => {
  const { store, cleanup } = freshDb("chunks");
  try {
    const doc = store.createSourceDocument({ userId: "u1", kind: "file", uri: "src/a.ts", hash: "fa", title: "a.ts", workspaceTag: null });
    const first = store.addSourceChunks(doc.id, [
      { content: "chunk A", tokenCount: 2, filePath: "src/a.ts", symbol: "fnA", startLine: 1, endLine: 10 },
      { content: "chunk B", tokenCount: 3, filePath: "src/a.ts", symbol: "fnB", startLine: 11, endLine: 20 },
    ]);
    assert.deepEqual(first.map((c) => c.ordinal), [0, 1]);
    assert.equal(first[0].hash, createHash("sha1").update("chunk A").digest("hex"));
    assert.equal(first[0].symbol, "fnA");

    // a second append continues the ordinal sequence
    const more = store.addSourceChunks(doc.id, [{ content: "chunk C", tokenCount: 1 }]);
    assert.equal(more[0].ordinal, 2);
    assert.equal(more[0].filePath, null);

    const all = store.getSourceChunksByDocument(doc.id);
    assert.deepEqual(all.map((c) => c.content), ["chunk A", "chunk B", "chunk C"]);
    assert.equal(store.getSourceChunk(first[1].id)?.content, "chunk B");
  } finally {
    cleanup();
  }
});
