import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { asyncify } from "../memory/store/asyncify.js";
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
  return { engine: new MemoryEngine(asyncify(store)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("brain cognitive ports (tree/lessons/blackboard) delegate to their engine-bound modules", async () => {
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
    const rec = await lessons.record(u, "always run the full suite before pushing");
    assert.equal(typeof rec.recordId, "string");
    assert.deepEqual(
      await lessons.findConflicts(u, "always run the full suite before pushing"),
      await findLessonConflicts(engine, u, "always run the full suite before pushing"),
    );
    assert.ok(Array.isArray((await lessons.sweepStale(u)).candidates));

    // tree — append a leaf, then walk parity vs the module.
    await tree.appendLeaf(u, "source", "a source-scope summary");
    assert.deepEqual(await tree.walk(u), await treeWalk(engine, u));

    // blackboard — read-only parity + reconcile shape.
    assert.deepEqual(await bb.review(u), await reviewBlackboard(engine, u));
    assert.equal(typeof (await bb.reconcile(u)).reconciled, "number");
  } finally {
    cleanup();
  }
});
