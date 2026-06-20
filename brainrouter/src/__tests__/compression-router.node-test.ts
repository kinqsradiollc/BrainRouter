import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { compress, decodeLosslessTable } from "../memory/compression/router.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-compression-router-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("JSON crushing preserves anchors, errors, anomalies, and the target token ratio", () => {
  const { store, cleanup } = freshDb("json");
  try {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: index,
      metric: index === 113 ? 99_999 : index % 11,
      message: index === 91 ? "ERROR connection failed" : `normal record ${index} with repeated payload`,
    }));
    const result = compress(JSON.stringify(rows), {
      userId: "u1",
      store,
      targetKeep: 0.2,
    });
    const compressedRows = JSON.parse(result.compressed) as Array<{ id?: number; message?: string; _ccr_dropped?: string }>;

    assert.equal(result.kind, "json");
    assert.equal(result.strategy, "smart-crush");
    assert.ok(result.hash);
    assert.ok(result.compressedTokens / result.originalTokens <= 0.2);
    assert.equal(compressedRows[0]?.id, 0);
    assert.equal(compressedRows.some((row) => row.id === 199), true);
    assert.equal(compressedRows.some((row) => row.id === 91), true);
    assert.equal(compressedRows.some((row) => row.id === 113), true);
    assert.match(compressedRows.at(-1)?._ccr_dropped ?? "", /^<<ccr:[a-f0-9]{24} \d+_rows_offloaded>>$/);

    const restored = store.retrieveCompressionEntry("u1", result.hash!);
    assert.equal(restored?.originalContent, JSON.stringify(rows));
  } finally {
    cleanup();
  }
});

test("homogeneous JSON rows use the smaller lossless table path", () => {
  const { store, cleanup } = freshDb("lossless");
  try {
    const rows = Array.from({ length: 64 }, (_, index) => ({ id: index, state: index % 2 === 0 ? "ready" : "idle", active: index % 2 === 0 }));
    const result = compress(JSON.stringify(rows), { userId: "u1", store, preferLossless: true, targetKeep: 0.95 });

    assert.equal(result.kind, "json");
    assert.equal(result.strategy, "lossless-table");
    assert.equal(result.hash, null);
    assert.deepEqual(decodeLosslessTable(result.compressed), rows);
  } finally {
    cleanup();
  }
});
