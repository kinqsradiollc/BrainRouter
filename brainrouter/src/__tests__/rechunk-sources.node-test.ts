import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * 0.4.3 (MEM-10) — source_chunker re-chunk job. Provenance-safe: re-chunking
 * mints new chunk ids, so a doc whose chunks back a live memory must be skipped
 * (else cognitive_source_links orphan). user-scoped.
 */

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-rechunk-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDoc(store: SqliteMemoryStore, userId: string, hash: string) {
  const doc = store.createSourceDocument({ userId, workspaceTag: null, kind: "transcript", uri: null, hash, title: "t" });
  const chunks = store.addSourceChunks(doc.id, [
    { content: "first chunk content alpha", tokenCount: 4 },
    { content: "second chunk content beta", tokenCount: 4 },
  ]);
  return { doc, chunkIds: chunks.map((c) => c.id) };
}

test("store: isSourceDocumentReferenced + replaceSourceChunks", () => {
  const { store, cleanup } = fresh("store");
  try {
    const { doc, chunkIds } = makeDoc(store, "u1", "h1");
    assert.equal(store.isSourceDocumentReferenced(doc.id), false, "unlinked doc is not referenced");

    const replaced = store.replaceSourceChunks(doc.id, [{ content: "merged content", tokenCount: 2 }]);
    assert.equal(replaced.length, 1, "replaced with a single chunk");
    const now = store.getSourceChunksByDocument(doc.id);
    assert.equal(now.length, 1);
    assert.equal(now[0].ordinal, 0, "ordinals restart from 0 after replace");
    assert.ok(!chunkIds.includes(now[0].id), "new chunk id (old ones deleted)");

    // Link the new chunk to a record → now referenced.
    store.linkRecordSources("u1", "recA", [now[0].id]);
    assert.equal(store.isSourceDocumentReferenced(doc.id), true, "linked doc is referenced");
  } finally {
    cleanup();
  }
});

test("engine.rechunkSources: re-chunks unreferenced; SKIPS referenced + foreign-user docs", () => {
  const { store, cleanup } = fresh("engine");
  try {
    const engine = new MemoryEngine(store);

    // Unreferenced doc → re-chunked (new chunk ids).
    const free = makeDoc(store, "u1", "h-free");
    // Referenced doc → must be skipped (provenance).
    const ref = makeDoc(store, "u1", "h-ref");
    store.linkRecordSources("u1", "recRef", [ref.chunkIds[0]]);

    const res = engine.rechunkSources("u1", [free.doc.id, ref.doc.id]);
    assert.equal(res.rechunked, 1, "only the unreferenced doc is re-chunked");
    assert.equal(res.skipped, 1, "the referenced doc is skipped");
    assert.ok(res.chunksWritten >= 1);

    // free doc: chunk ids changed.
    const freeNow = store.getSourceChunksByDocument(free.doc.id).map((c) => c.id);
    assert.ok(freeNow.every((id) => !free.chunkIds.includes(id)), "free doc re-chunked (new ids)");
    // ref doc: chunks untouched (provenance intact).
    const refNow = store.getSourceChunksByDocument(ref.doc.id).map((c) => c.id);
    assert.deepEqual(refNow, ref.chunkIds, "referenced doc chunks unchanged");
    assert.equal(store.getRecordSourceChunks("u1", "recRef").length, 1, "live provenance intact");

    // Foreign user can't re-chunk u1's doc.
    const foreign = engine.rechunkSources("other", [free.doc.id]);
    assert.equal(foreign.rechunked, 0);
    assert.equal(foreign.skipped, 1);
  } finally {
    cleanup();
  }
});
