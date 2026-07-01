import test from "node:test";
import assert from "node:assert/strict";
import { compress, decodeLosslessTable } from "../memory/compression/router.js";
import { createTestStore } from "./helpers/pgTestStore.js";

test("JSON crushing preserves anchors, errors, anomalies, and the target token ratio", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: index,
      metric: index === 113 ? 99_999 : index % 11,
      message: index === 91 ? "ERROR connection failed" : `normal record ${index} with repeated payload`,
    }));
    const result = await compress(JSON.stringify(rows), {
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

    const restored = await store.retrieveCompressionEntry("u1", result.hash!);
    assert.equal(restored?.originalContent, JSON.stringify(rows));
  } finally {
    await cleanup();
  }
});

test("homogeneous JSON rows use the smaller lossless table path", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const rows = Array.from({ length: 64 }, (_, index) => ({ id: index, state: index % 2 === 0 ? "ready" : "idle", active: index % 2 === 0 }));
    const result = await compress(JSON.stringify(rows), { userId: "u1", store, preferLossless: true, targetKeep: 0.95 });

    assert.equal(result.kind, "json");
    assert.equal(result.strategy, "lossless-table");
    assert.equal(result.hash, null);
    assert.deepEqual(decodeLosslessTable(result.compressed), rows);
  } finally {
    cleanup();
  }
});
