import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem3-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-3 store: link + fetch record→chunks (ordered, idempotent)", () => {
  const { store, cleanup } = fresh("store");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h-mem3", title: "t" });
    const chunks = store.addSourceChunks(doc.id, [
      { content: "first chunk content", tokenCount: 4 },
      { content: "second chunk content", tokenCount: 4 },
    ]);
    const ids = chunks.map((c) => c.id);
    store.linkRecordSources("u1", "rec1", ids);
    store.linkRecordSources("u1", "rec1", ids); // re-extraction must not duplicate
    const got = store.getRecordSourceChunks("rec1");
    assert.deepEqual(got.map((c) => c.content), ["first chunk content", "second chunk content"]);
    assert.equal(got.length, 2, "idempotent — no duplicate links");
  } finally { cleanup(); }
});

test("MEM-3 store: empty link is a no-op; unknown record → []", () => {
  const { store, cleanup } = fresh("empty");
  try {
    store.linkRecordSources("u1", "recX", []);
    assert.deepEqual(store.getRecordSourceChunks("recX"), []);
    assert.deepEqual(store.getRecordSourceChunks("nope"), []);
  } finally { cleanup(); }
});

test("MEM-3 engine.getRecordProvenance: excerpts (truncated >280) + empty when unlinked", () => {
  const { store, cleanup } = fresh("engine");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/a.ts", hash: "h-eng", title: "a.ts" });
    const long = "x".repeat(400);
    const [c] = store.addSourceChunks(doc.id, [{ content: long, tokenCount: 100, filePath: "src/a.ts", symbol: "fnA", startLine: 1, endLine: 40 }]);
    store.linkRecordSources("u1", "recE", [c.id]);

    const engine = new MemoryEngine(store);
    const prov = engine.getRecordProvenance("recE");
    assert.equal(prov.length, 1);
    assert.equal(prov[0].filePath, "src/a.ts");
    assert.equal(prov[0].symbol, "fnA");
    assert.equal(prov[0].startLine, 1);
    assert.equal(prov[0].excerpt.length, 281, "280 chars + a single ellipsis");
    assert.ok(prov[0].excerpt.endsWith("…"));
    assert.deepEqual(engine.getRecordProvenance("unlinked"), [], "no links → no provenance");
  } finally { cleanup(); }
});
