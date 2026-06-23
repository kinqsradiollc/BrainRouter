import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestStore } from "./helpers/pgTestStore.js";

test("0.4.3 source_documents: create + round-trip + idempotent by (user, hash)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const doc = await store.createSourceDocument({
      userId: "u1", workspaceTag: "ws16", kind: "tool_output",
      uri: "npm test", hash: "h1", title: "test run", metadata: { exit: 1 },
    });
    assert.ok(doc.id);
    const got = await store.getSourceDocument(doc.id);
    assert.equal(got?.uri, "npm test");
    assert.equal(got?.kind, "tool_output");
    assert.deepEqual(got?.metadata, { exit: 1 });
    // re-ingest identical content (same user+hash) returns the SAME row, no dup
    const again = await store.createSourceDocument({ userId: "u1", kind: "tool_output", uri: "npm test", hash: "h1", title: "test run", workspaceTag: "ws16" });
    assert.equal(again.id, doc.id);
    // different user with same hash is a distinct doc
    const other = await store.createSourceDocument({ userId: "u2", kind: "tool_output", uri: "npm test", hash: "h1", title: "x", workspaceTag: null });
    assert.notEqual(other.id, doc.id);
  } finally {
    await cleanup();
  }
});

test("0.4.3 source_chunks: append assigns ordinals + sha1 hash; fetch ordered", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const doc = await store.createSourceDocument({ userId: "u1", kind: "file", uri: "src/a.ts", hash: "fa", title: "a.ts", workspaceTag: null });
    const first = await store.addSourceChunks(doc.id, [
      { content: "chunk A", tokenCount: 2, filePath: "src/a.ts", symbol: "fnA", startLine: 1, endLine: 10 },
      { content: "chunk B", tokenCount: 3, filePath: "src/a.ts", symbol: "fnB", startLine: 11, endLine: 20 },
    ]);
    assert.deepEqual(first.map((c) => c.ordinal), [0, 1]);
    assert.equal(first[0].hash, createHash("sha1").update("chunk A").digest("hex"));
    assert.equal(first[0].symbol, "fnA");

    // a second append continues the ordinal sequence
    const more = await store.addSourceChunks(doc.id, [{ content: "chunk C", tokenCount: 1 }]);
    assert.equal(more[0].ordinal, 2);
    assert.equal(more[0].filePath, null);

    const all = await store.getSourceChunksByDocument(doc.id);
    assert.deepEqual(all.map((c) => c.content), ["chunk A", "chunk B", "chunk C"]);
    assert.equal((await store.getSourceChunk(first[1].id))?.content, "chunk B");
  } finally {
    await cleanup();
  }
});

test("0.4.3 getSourceDocuments: lists a user's docs newest-first with chunk counts (dashboard Sources)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const d1 = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h1", title: "first" });
    await store.addSourceChunks(d1.id, [{ content: "a", tokenCount: 1 }, { content: "b", tokenCount: 1 }]);
    const d2 = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "x.ts", hash: "h2", title: "second" });
    await store.createSourceDocument({ userId: "u2", workspaceTag: null, kind: "file", uri: "y.ts", hash: "h3", title: "other-user" });

    const docs = await store.getSourceDocuments("u1");
    assert.equal(docs.length, 2, "only u1's docs (user-scoped, u2 excluded)");
    assert.deepEqual(docs.map((d) => d.id).sort(), [d1.id, d2.id].sort());
    assert.ok(docs.every((d) => d.userId === "u1"));
    assert.equal(docs.find((d) => d.id === d1.id)!.chunkCount, 2);
    assert.equal(docs.find((d) => d.id === d2.id)!.chunkCount, 0);
  } finally {
    await cleanup();
  }
});
