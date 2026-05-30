import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem8-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(store: SqliteMemoryStore) {
  const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/a.ts", hash: "h8", title: "a.ts" });
  const chunks = store.addSourceChunks(doc.id, [
    { content: "AAA", tokenCount: 1 },
    { content: "BBB", tokenCount: 1 },
    { content: "CCC", tokenCount: 1 },
  ]);
  return { doc, chunks };
}

test("MEM-8 fetchSourceChunk: full chunk + parent document, no neighbors by default", () => {
  const { store, cleanup } = fresh("basic");
  try {
    const { chunks } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.fetchSourceChunk("u1", chunks[1].id);
    assert.ok(r);
    assert.equal(r!.chunk.content, "BBB");
    assert.equal(r!.document?.uri, "src/a.ts");
    assert.equal(r!.document?.kind, "file");
    assert.deepEqual(r!.neighbors, []);
    // user-scoped: another user cannot fetch u1's chunk (cross-tenant guard)
    assert.equal(engine.fetchSourceChunk("other", chunks[1].id), null);
  } finally { cleanup(); }
});

test("MEM-8 fetchSourceChunk: ±N neighbours from the same document, excluding self", () => {
  const { store, cleanup } = fresh("neighbors");
  try {
    const { chunks } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.fetchSourceChunk("u1", chunks[1].id, 1);
    assert.ok(r);
    assert.deepEqual(r!.neighbors.map((c) => c.content), ["AAA", "CCC"]);
  } finally { cleanup(); }
});

test("MEM-8 fetchSourceChunk: unknown id → null", () => {
  const { store, cleanup } = fresh("missing");
  try {
    const engine = new MemoryEngine(store);
    assert.equal(engine.fetchSourceChunk("u1", "does-not-exist"), null);
  } finally { cleanup(); }
});
