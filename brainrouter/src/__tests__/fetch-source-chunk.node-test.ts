import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";
import type { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";

async function seed(store: PostgresMemoryStore) {
  const doc = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/a.ts", hash: "h8", title: "a.ts" });
  const chunks = await store.addSourceChunks(doc.id, [
    { content: "AAA", tokenCount: 1 },
    { content: "BBB", tokenCount: 1 },
    { content: "CCC", tokenCount: 1 },
  ]);
  return { doc, chunks };
}

test("MEM-8 fetchSourceChunk: full chunk + parent document, no neighbors by default", async () => {
  const { engine, store, cleanup } = await createTestEngine();
  try {
    const { chunks } = await seed(store);
    const r = await engine.fetchSourceChunk("u1", chunks[1].id);
    assert.ok(r);
    assert.equal(r!.chunk.content, "BBB");
    assert.equal(r!.document?.uri, "src/a.ts");
    assert.equal(r!.document?.kind, "file");
    assert.deepEqual(r!.neighbors, []);
    // user-scoped: another user cannot fetch u1's chunk (cross-tenant guard)
    assert.equal(await engine.fetchSourceChunk("other", chunks[1].id), null);
  } finally { await cleanup(); }
});

test("MEM-8 fetchSourceChunk: ±N neighbours from the same document, excluding self", async () => {
  const { engine, store, cleanup } = await createTestEngine();
  try {
    const { chunks } = await seed(store);
    const r = await engine.fetchSourceChunk("u1", chunks[1].id, 1);
    assert.ok(r);
    assert.deepEqual(r!.neighbors.map((c) => c.content), ["AAA", "CCC"]);
  } finally { await cleanup(); }
});

test("MEM-8 fetchSourceChunk: unknown id → null", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    assert.equal(await engine.fetchSourceChunk("u1", "does-not-exist"), null);
  } finally { await cleanup(); }
});
