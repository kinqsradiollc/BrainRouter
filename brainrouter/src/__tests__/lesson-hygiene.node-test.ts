import test from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./helpers/pgTestStore.js";

test("LESSON-HYGIENE recordLesson stores a conflictKey and findLessonConflicts surfaces same-subject lessons", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    await engine.recordLesson("u1", "Always use pnpm");
    // A reversed-polarity rule about the SAME subject is a conflict candidate.
    const conflicts = await engine.findLessonConflicts("u1", "Never use pnpm");
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].content, /Always use pnpm/);
    // A rule about a DIFFERENT subject is not flagged (no semantic guessing).
    assert.equal((await engine.findLessonConflicts("u1", "Run tests before push")).length, 0);
  } finally {
    await cleanup();
  }
});

test("LESSON-HYGIENE explicit supersedes invalidates the prior lesson and points superseded_by at the new one", async () => {
  const { store, engine, cleanup } = await createTestEngine();
  try {
    const first = await engine.recordLesson("u1", "Deploy from the staging branch");
    const second = await engine.recordLesson("u1", "Deploy from the release branch", { supersedes: first.recordId });

    assert.deepEqual(second.supersededIds, [first.recordId]);

    const old = await store.getMemoryById("u1", first.recordId);
    assert.ok(old, "old record still exists (invalidated, not deleted)");
    assert.equal(old!.supersededBy, second.recordId);
    assert.ok(old!.invalidAt, "old record carries an invalid_at timestamp");
    assert.equal(old!.status, "superseded");
  } finally {
    await cleanup();
  }
});

test("LESSON-HYGIENE supersedes is best-effort: an unknown id is skipped, not fatal", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const res = await engine.recordLesson("u1", "Cache the build artifacts", { supersedes: ["does-not-exist"] });
    assert.ok(res.recordId);
    assert.deepEqual(res.supersededIds, [], "unknown id is not reported as superseded");
  } finally {
    await cleanup();
  }
});

test("LESSON-HYGIENE sweepStaleLessons is conservative and read-only by default; apply archives candidates", async () => {
  const { store, engine, cleanup } = await createTestEngine();
  try {
    const weak = await engine.recordLesson("u1", "Temporary workaround for the flaky test");
    const strong = await engine.recordLesson("u1", "Run the migration before seeding");
    // Make the strong lesson trusted + corroborated so it is never a candidate.
    await engine.recordLesson("u1", "Run the migration before seeding"); // reinforce → conf up, corroborations=2

    // `now` far in the future so the default 120-day window is exceeded.
    const farFuture = Date.parse("2027-01-01T00:00:00.000Z");

    const dryRun = await engine.sweepStaleLessons("u1", { nowMs: farFuture });
    const ids = dryRun.candidates.map((c) => c.recordId);
    assert.ok(ids.includes(weak.recordId), "weak/old lesson is a candidate");
    assert.ok(!ids.includes(strong.recordId), "corroborated lesson is protected");
    assert.equal(dryRun.archived, 0, "dry run does not archive");

    // Still live before apply.
    assert.equal((await store.getMemoryById("u1", weak.recordId))!.archived, false);

    const applied = await engine.sweepStaleLessons("u1", { nowMs: farFuture, apply: true });
    assert.ok(applied.archived >= 1);
    assert.equal((await store.getMemoryById("u1", weak.recordId))!.archived, true, "candidate archived after apply");
  } finally {
    await cleanup();
  }
});
