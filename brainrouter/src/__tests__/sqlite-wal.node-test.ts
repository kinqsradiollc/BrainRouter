/**
 * Federation Stage 1 (FED-S1-T1) WAL integration test.
 *
 * Why this file uses `node:test` instead of vitest:
 *   The brainrouter package runs its main suite under vitest 1.6, whose
 *   bundled vite version cannot resolve `node:sqlite` (Node 22's native
 *   sqlite). Any vitest file that transitively imports our store fails
 *   with `Failed to load url sqlite`. Until the vitest upgrade lands,
 *   integration tests that need a real `DatabaseSync` connection live
 *   here and run via `node --test dist/__tests__/*.node-test.js` from
 *   the `test:integration` npm script.
 *
 * What it verifies (federation Stage 1 — WAL concurrency):
 *   1. SqliteMemoryStore reports journal_mode=wal after construction.
 *   2. Two store instances pointed at the same file can read AND write
 *      concurrently — the federation guarantee that one CLI's
 *      extraction transaction does not block another CLI's recall.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

function freshDbPath(label: string): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-wal-${label}-`));
  const path = join(dir, "memory.db");
  return {
    dir,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("SqliteMemoryStore reports journal_mode=wal after construction", () => {
  const { path, cleanup } = freshDbPath("single");
  try {
    const store = new SqliteMemoryStore(path);
    store.init();
    assert.equal(store.getJournalMode().toLowerCase(), "wal");
  } finally {
    cleanup();
  }
});

test("Two stores on one file: concurrent reader unaffected by an open writer transaction", () => {
  // Two stores on one file mirrors the federation runtime: BrainRouter CLI
  // and Claude Code each open their own connection to the shared DB.
  const { path, cleanup } = freshDbPath("concurrent");
  try {
    const writer = new SqliteMemoryStore(path);
    writer.init();
    const reader = new SqliteMemoryStore(path);
    reader.init();

    // Both connections must independently report WAL.
    assert.equal(writer.getJournalMode().toLowerCase(), "wal");
    assert.equal(reader.getJournalMode().toLowerCase(), "wal");

    // Drop into a long-running write transaction on the writer.
    const writerDb = (writer as unknown as { db: { exec(sql: string): void } }).db;
    writerDb.exec("BEGIN IMMEDIATE");
    writerDb.exec(
      "CREATE TABLE IF NOT EXISTS fed_concurrency_probe (id INTEGER PRIMARY KEY, payload TEXT)",
    );
    writerDb.exec("INSERT INTO fed_concurrency_probe (payload) VALUES ('row-during-tx')");

    // While the writer holds an open transaction, the reader must still
    // be able to query. Under rollback-journal mode this would block on
    // the SHARED lock; under WAL the reader sees its pre-transaction
    // snapshot and returns immediately. We probe sqlite_master so the
    // assertion runs even though the new table is invisible to the
    // reader's snapshot.
    const readerDb = (reader as unknown as {
      db: { prepare(sql: string): { all(): unknown[] } };
    }).db;
    const sawTable = readerDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fed_concurrency_probe'")
      .all();
    assert.equal(sawTable.length, 0);

    // Commit the writer. The reader can now see the row from a fresh query.
    writerDb.exec("COMMIT");
    const seen = readerDb
      .prepare("SELECT payload FROM fed_concurrency_probe")
      .all() as Array<{ payload: string }>;
    assert.ok(
      seen.some((r) => r.payload === "row-during-tx"),
      "reader must see committed row after writer commits",
    );
  } finally {
    cleanup();
  }
});
