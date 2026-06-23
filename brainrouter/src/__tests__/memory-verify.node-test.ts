import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";
import { MemoryEngine } from "../memory/engine.js";
import { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";

/** Create a code-anchored memory: a record linked to a chunk of `uri`. */
async function anchor(engine: MemoryEngine, store: PostgresMemoryStore, uri: string, hash: string, lesson: string): Promise<string> {
  const doc = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri, hash, title: uri });
  const chunks = await store.addSourceChunks(doc.id, [
    { content: `// ${uri}\n${lesson}`, tokenCount: 8, filePath: uri, symbol: "fn", startLine: 1, endLine: 2 },
  ]);
  const rec = await engine.recordLesson("u1", lesson);
  await store.linkRecordSources("u1", rec.recordId, [chunks[0].id]);
  return rec.recordId;
}

test("B6 memory_verify: classifies fresh / re-anchorable / archivable, ignores non-code", async () => {
  const { engine, store, cleanup } = await createTestEngine();
  try {
    // 1) fresh — anchored, source not stale.
    const recFresh = await anchor(engine, store, "src/fresh.ts", "hF", "Lesson: fresh.ts parser always trims input first.");

    // 2) re-anchorable — anchored, source stale, BUT a fresh doc still exists at the uri (file changed).
    const recChanged = await anchor(engine, store, "src/changed.ts", "hC1", "Lesson: changed.ts validates before parse.");
    await store.markSourceDocumentsStaleByPath("u1", "src/changed.ts");
    // The file changed + was reindexed → a NEW fresh doc exists at the same uri.
    await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/changed.ts", hash: "hC2", title: "src/changed.ts" });

    // 3) archivable — anchored, source stale, NO fresh doc at the uri (file gone).
    const recDeleted = await anchor(engine, store, "src/deleted.ts", "hD", "Lesson: deleted.ts used the old codepath.");
    await store.markSourceDocumentsStaleByPath("u1", "src/deleted.ts");

    // 4) non-code memory — no source chunks → ignored by verify.
    await engine.recordLesson("u1", "Lesson: the user prefers concise summaries (no code anchor).");

    const report = await engine.verifyMemories("u1");
    assert.equal(report.total, 3, "three code-anchored records examined (the plain lesson is ignored)");
    assert.equal(report.fresh, 1);
    assert.equal(report.reanchorable, 1);
    assert.equal(report.archivable, 1);
    assert.equal(report.archived, 0, "read-only by default — nothing archived");
    void recFresh; void recChanged; void recDeleted;
  } finally { await cleanup(); }
});

test("B6 memory_verify apply: archives ONLY the confirmed-dead anchor", async () => {
  const { engine, store, cleanup } = await createTestEngine();
  try {
    const recFresh = await anchor(engine, store, "src/keep.ts", "hK", "Lesson: keep.ts is the entry point.");
    const recChanged = await anchor(engine, store, "src/edit.ts", "hE1", "Lesson: edit.ts has the validation.");
    await store.markSourceDocumentsStaleByPath("u1", "src/edit.ts");
    await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/edit.ts", hash: "hE2", title: "src/edit.ts" });
    const recGone = await anchor(engine, store, "src/gone.ts", "hG", "Lesson: gone.ts handled the legacy format.");
    await store.markSourceDocumentsStaleByPath("u1", "src/gone.ts");

    const applied = await engine.verifyMemories("u1", { apply: true });
    assert.equal(applied.archivable, 1);
    assert.equal(applied.archived, 1, "the one dead-anchor record was archived");

    const active = (await store.listMemories("u1", { archived: false })).map((r) => r.recordId);
    assert.ok(!active.includes(recGone), "dead-anchor record archived (dropped from active recall)");
    assert.ok(active.includes(recFresh), "fresh record kept");
    assert.ok(active.includes(recChanged), "re-anchorable (file-changed) record kept — NOT archived");
  } finally { await cleanup(); }
});
