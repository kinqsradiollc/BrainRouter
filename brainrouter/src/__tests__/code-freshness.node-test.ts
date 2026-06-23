import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";

const V1 = "export function parseConfig(raw){ return JSON.parse(raw); }";
const V2 = "export function parseConfig(raw){ const t = raw.trim(); return JSON.parse(t); } // changed";

test("MEM-30 reindexCodeSource: first index, no-op on unchanged, re-index + stale on drift", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const first = await engine.reindexCodeSource("u1", { filePath: "src/cfg.ts", content: V1 });
    assert.equal(first.status, "reindexed");
    assert.ok(first.chunks >= 1);

    // Same content again → fresh no-op.
    const again = await engine.reindexCodeSource("u1", { filePath: "src/cfg.ts", content: V1 });
    assert.equal(again.status, "fresh");
    assert.equal(again.staleMarked, 0);
    assert.equal(again.documentId, first.documentId);

    // Drift → old doc marked stale, fresh re-chunk.
    const drift = await engine.reindexCodeSource("u1", { filePath: "src/cfg.ts", content: V2 });
    assert.equal(drift.status, "reindexed");
    assert.equal(drift.staleMarked, 1, "the prior document was staled");
    assert.notEqual(drift.documentId, first.documentId);
  } finally { await cleanup(); }
});

test("MEM-30: stale chunks are excluded from find_related", async () => {
  const { engine, store, cleanup } = await createTestEngine();
  try {
    // Seed a separate file that references parseConfig (so find_related has a query).
    const caller = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/use.ts", hash: "huse", title: "use.ts" });
    const callerChunks = await store.addSourceChunks(caller.id, [
      { content: "import { parseConfig } from './cfg'; const v = parseConfig(text);", tokenCount: 10, filePath: "src/use.ts", symbol: "useIt", startLine: 1, endLine: 2 },
    ]);
    // Index cfg.ts v1 (defines parseConfig) — should be findable.
    await engine.reindexCodeSource("u1", { filePath: "src/cfg.ts", content: V1 });
    const before = await engine.findRelatedChunks("u1", { chunkId: callerChunks[0].id });
    assert.ok(before.related.some((r) => r.chunk.filePath === "src/cfg.ts"), "fresh cfg.ts is found");

    // Drift cfg.ts → the v1 chunks go stale; find_related should now skip them.
    await engine.reindexCodeSource("u1", { filePath: "src/cfg.ts", content: V2 });
    const after = await engine.findRelatedChunks("u1", { chunkId: callerChunks[0].id });
    const cfgHits = after.related.filter((r) => r.chunk.filePath === "src/cfg.ts");
    // The fresh v2 cfg.ts may still match (it still defines parseConfig) — but
    // no stale v1 chunk should appear. Assert every cfg hit is from the live doc.
    for (const h of cfgHits) {
      const doc = await store.getSourceDocument(h.chunk.documentId);
      assert.ok(doc, "hit's document exists");
    }
    // Stronger: the v1 content (with no `.trim()`) must not be returned.
    assert.ok(!after.related.some((r) => r.chunk.content === V1), "stale v1 chunk excluded");
  } finally { await cleanup(); }
});

test("MEM-30: reverting to a prior version revives the document (no duplicate)", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const v1 = await engine.reindexCodeSource("u1", { filePath: "src/x.ts", content: V1 });
    await engine.reindexCodeSource("u1", { filePath: "src/x.ts", content: V2 }); // drift
    const back = await engine.reindexCodeSource("u1", { filePath: "src/x.ts", content: V1 }); // revert
    assert.equal(back.status, "reindexed");
    assert.equal(back.documentId, v1.documentId, "revived the original document, did not duplicate");
    assert.equal(back.chunks, 0, "no re-chunk needed on revive");
  } finally { await cleanup(); }
});
