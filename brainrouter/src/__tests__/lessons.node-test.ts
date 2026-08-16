import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";

test("MEM-32 recordLesson: corroboration reinforces (no duplicate, confidence rises)", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const first = await engine.recordLesson("u1", "Always run the migration before seeding the database.");
    assert.equal(first.reinforced, false);
    assert.equal(first.corroborations, 1);
    const c0 = first.confidence;

    // Same lesson, trivially reworded whitespace/case → same fingerprint.
    const second = await engine.recordLesson("u1", "  ALWAYS run the migration   before seeding the database.  ");
    assert.equal(second.reinforced, true, "corroboration reinforces rather than duplicating");
    assert.equal(second.recordId, first.recordId, "same record");
    assert.equal(second.corroborations, 2);
    assert.ok(second.confidence > c0, "confidence rises on corroboration");

    const third = await engine.recordLesson("u1", "Always run the migration before seeding the database.");
    assert.ok(third.confidence >= second.confidence && third.confidence <= 0.99);
    assert.equal(third.corroborations, 3);
    assert.equal(third.recordId, first.recordId, "still the same single record after 3 corroborations");
  } finally { await cleanup(); }
});

test("MEM-32 recordLesson: a distinct lesson is a separate record", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const a = await engine.recordLesson("u1", "Prefer composition over inheritance for adapters.");
    const b = await engine.recordLesson("u1", "Cache the tokenizer; constructing it per call is slow.");
    assert.notEqual(a.recordId, b.recordId);
    assert.equal(a.reinforced, false);
    assert.equal(b.reinforced, false);
  } finally { await cleanup(); }
});

test("MEM-32 lessons are scoped per user (no cross-tenant reinforcement)", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const u1 = await engine.recordLesson("u1", "Tag releases with the changelog hash.");
    const u2 = await engine.recordLesson("u2", "Tag releases with the changelog hash.");
    assert.equal(u2.reinforced, false, "u2's identical lesson does not reinforce u1's");
    assert.notEqual(u1.recordId, u2.recordId);
  } finally { await cleanup(); }
});

test("ADR-032 lessons are scoped by organization for the same user", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const orgA = await engine.recordLesson("u1", "Use the tenant deployment checklist.", {
      orgId: "org-a",
    });
    const orgB = await engine.recordLesson("u1", "Use the tenant deployment checklist.", {
      orgId: "org-b",
    });
    const personal = await engine.recordLesson("u1", "Use the tenant deployment checklist.", {
      orgId: null,
    });
    assert.equal(orgB.reinforced, false);
    assert.equal(personal.reinforced, false);
    assert.equal(new Set([orgA.recordId, orgB.recordId, personal.recordId]).size, 3);
  } finally { await cleanup(); }
});
