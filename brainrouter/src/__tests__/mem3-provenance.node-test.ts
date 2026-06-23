import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import { MemoryEngine } from "../memory/engine.js";

test("MEM-3 store: link + fetch record→chunks (ordered, idempotent)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const doc = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h-mem3", title: "t" });
    const chunks = await store.addSourceChunks(doc.id, [
      { content: "first chunk content", tokenCount: 4 },
      { content: "second chunk content", tokenCount: 4 },
    ]);
    const ids = chunks.map((c) => c.id);
    await store.linkRecordSources("u1", "rec1", ids);
    await store.linkRecordSources("u1", "rec1", ids); // re-extraction must not duplicate
    const got = await store.getRecordSourceChunks("u1", "rec1");
    assert.deepEqual(got.map((c) => c.content), ["first chunk content", "second chunk content"]);
    assert.equal(got.length, 2, "idempotent — no duplicate links");
    // user-scoped: another user must NOT see u1's provenance (cross-tenant guard)
    assert.deepEqual(await store.getRecordSourceChunks("other", "rec1"), []);
  } finally { await cleanup(); }
});

test("MEM-3 store: empty link is a no-op; unknown record → []", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.linkRecordSources("u1", "recX", []);
    assert.deepEqual(await store.getRecordSourceChunks("u1", "recX"), []);
    assert.deepEqual(await store.getRecordSourceChunks("u1", "nope"), []);
  } finally { await cleanup(); }
});

test("MEM-3 engine.getRecordProvenance: excerpts (truncated >280) + empty when unlinked", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const doc = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/a.ts", hash: "h-eng", title: "a.ts" });
    const long = "x".repeat(400);
    const [c] = await store.addSourceChunks(doc.id, [{ content: long, tokenCount: 100, filePath: "src/a.ts", symbol: "fnA", startLine: 1, endLine: 40 }]);
    await store.linkRecordSources("u1", "recE", [c.id]);

    const engine = new MemoryEngine(store);
    const prov = await engine.getRecordProvenance("u1", "recE");
    assert.equal(prov.length, 1);
    assert.equal(prov[0].filePath, "src/a.ts");
    assert.equal(prov[0].symbol, "fnA");
    assert.equal(prov[0].startLine, 1);
    assert.equal(prov[0].excerpt.length, 281, "280 chars + a single ellipsis");
    assert.ok(prov[0].excerpt.endsWith("…"));
    assert.deepEqual(await engine.getRecordProvenance("u1", "unlinked"), [], "no links → no provenance");
    assert.deepEqual(await engine.getRecordProvenance("other", "recE"), [], "another user sees no provenance");
  } finally { await cleanup(); }
});
