import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { createMemoryTreeService, MemoryTreeService } from "../memory/tree/service.js";
import { createLessonsService, LessonsService } from "../memory/lessons/service.js";
import { createBlackboardService, BlackboardService } from "../memory/blackboard/service.js";
import { treeWalk } from "../memory/tree/treeOps.js";
import { findLessonConflicts } from "../memory/lessons/lessonOps.js";
import { reviewBlackboard } from "../memory/blackboard/blackboardOps.js";

function fresh(): { engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "br-cognitive-"));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("brain cognitive ports (tree/lessons/blackboard) delegate to their engine-bound modules", () => {
  const { engine, cleanup } = fresh();
  const u = "u1";
  try {
    const tree = createMemoryTreeService(engine);
    const lessons = createLessonsService(engine);
    const bb = createBlackboardService(engine);
    assert.ok(tree instanceof MemoryTreeService);
    assert.ok(lessons instanceof LessonsService);
    assert.ok(bb instanceof BlackboardService);

    // lessons — record, then read-only parity vs the module.
    const rec = lessons.record(u, "always run the full suite before pushing");
    assert.equal(typeof rec.recordId, "string");
    assert.deepEqual(
      lessons.findConflicts(u, "always run the full suite before pushing"),
      findLessonConflicts(engine, u, "always run the full suite before pushing"),
    );
    assert.ok(Array.isArray(lessons.sweepStale(u).candidates));

    // tree — append a leaf, then walk parity vs the module.
    tree.appendLeaf(u, "source", "a source-scope summary");
    assert.deepEqual(tree.walk(u), treeWalk(engine, u));

    // blackboard — read-only parity + reconcile shape.
    assert.deepEqual(bb.review(u), reviewBlackboard(engine, u));
    assert.equal(typeof bb.reconcile(u).reconciled, "number");
  } finally {
    cleanup();
  }
});
