import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { churnAdjustedHalfLife, CHURN_HALF_LIFE_SCALE } from "../memory/reranker/penalties.js";

function fresh(label: string): { engine: MemoryEngine; store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-churn-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("B7 churnAdjustedHalfLife: null-safe + monotone shortening", () => {
  // No churn → unchanged (so existing data + every non-code memory score as before).
  assert.equal(churnAdjustedHalfLife(60, undefined), 60);
  assert.equal(churnAdjustedHalfLife(60, 0), 60);
  assert.equal(churnAdjustedHalfLife(60, null), 60);
  // A "never decays" base (null / 0) stays that way regardless of churn.
  assert.equal(churnAdjustedHalfLife(null, 100), null);
  assert.equal(churnAdjustedHalfLife(0, 100), 0);
  // More churn → shorter half-life, floored at 1 day.
  const low = churnAdjustedHalfLife(60, 10) as number;
  const high = churnAdjustedHalfLife(60, 100) as number;
  assert.ok(low < 60 && low > high, "more churn → shorter half-life");
  assert.ok((churnAdjustedHalfLife(60, 100_000) as number) >= 1, "floored at 1 day");
  // SCALE commits in 90d ≈ halves the half-life.
  assert.ok(Math.abs((churnAdjustedHalfLife(60, CHURN_HALF_LIFE_SCALE) as number) - 30) < 1e-9);
});

test("B7 churn data-flow: reindex stores churn; getRecordsMaxChurn surfaces it per anchored record", async () => {
  const { engine, store, cleanup } = fresh("flow");
  try {
    // Index a file WITH a captured churn signal.
    const r = await engine.reindexCodeSource("u1", {
      filePath: "src/hot.ts",
      content: "export const x = 1;",
      commitCount90d: 40,
      lastCommitDate: "2026-06-01",
    });
    assert.equal(r.status, "reindexed");
    assert.ok(r.documentId);

    // Anchor a memory to that hot file's document.
    const chunks = store.addSourceChunks(r.documentId!, [
      { content: "x", tokenCount: 2, filePath: "src/hot.ts", symbol: "x", startLine: 1, endLine: 1 },
    ]);
    const rec = await engine.recordLesson("u1", "Lesson anchored to a hot file.");
    store.linkRecordSources("u1", rec.recordId, [chunks[0].id]);

    const churn = store.getRecordsMaxChurn("u1", [rec.recordId]);
    assert.equal(churn.get(rec.recordId), 40, "max churn surfaced for the anchored record");

    // A record with no code anchor is absent → its decay stays unchanged.
    const plain = await engine.recordLesson("u1", "Lesson with no code anchor at all.");
    assert.equal(store.getRecordsMaxChurn("u1", [plain.recordId]).has(plain.recordId), false);
  } finally { cleanup(); }
});
