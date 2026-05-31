import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { engine: MemoryEngine; store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem32-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-32 recordLesson: corroboration reinforces (no duplicate, confidence rises)", () => {
  const { engine, cleanup } = fresh("reinforce");
  try {
    const first = engine.recordLesson("u1", "Always run the migration before seeding the database.");
    assert.equal(first.reinforced, false);
    assert.equal(first.corroborations, 1);
    const c0 = first.confidence;

    // Same lesson, trivially reworded whitespace/case → same fingerprint.
    const second = engine.recordLesson("u1", "  ALWAYS run the migration   before seeding the database.  ");
    assert.equal(second.reinforced, true, "corroboration reinforces rather than duplicating");
    assert.equal(second.recordId, first.recordId, "same record");
    assert.equal(second.corroborations, 2);
    assert.ok(second.confidence > c0, "confidence rises on corroboration");

    const third = engine.recordLesson("u1", "Always run the migration before seeding the database.");
    assert.ok(third.confidence >= second.confidence && third.confidence <= 0.99);
    assert.equal(third.corroborations, 3);
    assert.equal(third.recordId, first.recordId, "still the same single record after 3 corroborations");
  } finally { cleanup(); }
});

test("MEM-32 recordLesson: a distinct lesson is a separate record", () => {
  const { engine, cleanup } = fresh("distinct");
  try {
    const a = engine.recordLesson("u1", "Prefer composition over inheritance for adapters.");
    const b = engine.recordLesson("u1", "Cache the tokenizer; constructing it per call is slow.");
    assert.notEqual(a.recordId, b.recordId);
    assert.equal(a.reinforced, false);
    assert.equal(b.reinforced, false);
  } finally { cleanup(); }
});

test("MEM-32 lessons are scoped per user (no cross-tenant reinforcement)", () => {
  const { engine, cleanup } = fresh("scope");
  try {
    const u1 = engine.recordLesson("u1", "Tag releases with the changelog hash.");
    const u2 = engine.recordLesson("u2", "Tag releases with the changelog hash.");
    assert.equal(u2.reinforced, false, "u2's identical lesson does not reinforce u1's");
    assert.notEqual(u1.recordId, u2.recordId);
  } finally { cleanup(); }
});
