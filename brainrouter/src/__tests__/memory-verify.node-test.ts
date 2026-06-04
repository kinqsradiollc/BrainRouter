import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { engine: MemoryEngine; store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-verify-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Create a code-anchored memory: a record linked to a chunk of `uri`. */
function anchor(engine: MemoryEngine, store: SqliteMemoryStore, uri: string, hash: string, lesson: string): string {
  const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri, hash, title: uri });
  const chunks = store.addSourceChunks(doc.id, [
    { content: `// ${uri}\n${lesson}`, tokenCount: 8, filePath: uri, symbol: "fn", startLine: 1, endLine: 2 },
  ]);
  const rec = engine.recordLesson("u1", lesson);
  store.linkRecordSources("u1", rec.recordId, [chunks[0].id]);
  return rec.recordId;
}

test("B6 memory_verify: classifies fresh / re-anchorable / archivable, ignores non-code", () => {
  const { engine, store, cleanup } = fresh("classify");
  try {
    // 1) fresh — anchored, source not stale.
    const recFresh = anchor(engine, store, "src/fresh.ts", "hF", "Lesson: fresh.ts parser always trims input first.");

    // 2) re-anchorable — anchored, source stale, BUT a fresh doc still exists at the uri (file changed).
    const recChanged = anchor(engine, store, "src/changed.ts", "hC1", "Lesson: changed.ts validates before parse.");
    store.markSourceDocumentsStaleByPath("u1", "src/changed.ts");
    // The file changed + was reindexed → a NEW fresh doc exists at the same uri.
    store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/changed.ts", hash: "hC2", title: "src/changed.ts" });

    // 3) archivable — anchored, source stale, NO fresh doc at the uri (file gone).
    const recDeleted = anchor(engine, store, "src/deleted.ts", "hD", "Lesson: deleted.ts used the old codepath.");
    store.markSourceDocumentsStaleByPath("u1", "src/deleted.ts");

    // 4) non-code memory — no source chunks → ignored by verify.
    engine.recordLesson("u1", "Lesson: the user prefers concise summaries (no code anchor).");

    const report = engine.verifyMemories("u1");
    assert.equal(report.total, 3, "three code-anchored records examined (the plain lesson is ignored)");
    assert.equal(report.fresh, 1);
    assert.equal(report.reanchorable, 1);
    assert.equal(report.archivable, 1);
    assert.equal(report.archived, 0, "read-only by default — nothing archived");
    void recFresh; void recChanged; void recDeleted;
  } finally { cleanup(); }
});

test("B6 memory_verify apply: archives ONLY the confirmed-dead anchor", () => {
  const { engine, store, cleanup } = fresh("apply");
  try {
    const recFresh = anchor(engine, store, "src/keep.ts", "hK", "Lesson: keep.ts is the entry point.");
    const recChanged = anchor(engine, store, "src/edit.ts", "hE1", "Lesson: edit.ts has the validation.");
    store.markSourceDocumentsStaleByPath("u1", "src/edit.ts");
    store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/edit.ts", hash: "hE2", title: "src/edit.ts" });
    const recGone = anchor(engine, store, "src/gone.ts", "hG", "Lesson: gone.ts handled the legacy format.");
    store.markSourceDocumentsStaleByPath("u1", "src/gone.ts");

    const applied = engine.verifyMemories("u1", { apply: true });
    assert.equal(applied.archivable, 1);
    assert.equal(applied.archived, 1, "the one dead-anchor record was archived");

    const active = store.listMemories("u1", { archived: false }).map((r) => r.recordId);
    assert.ok(!active.includes(recGone), "dead-anchor record archived (dropped from active recall)");
    assert.ok(active.includes(recFresh), "fresh record kept");
    assert.ok(active.includes(recChanged), "re-anchorable (file-changed) record kept — NOT archived");
  } finally { cleanup(); }
});
