/**
 * AUG-A1 (0.4.1) — recall project-scope filter (applyFilters).
 *
 * node --test (recall.ts transitively pulls node:sqlite via the store
 * types). Pure-function behaviour check; no DB needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyFilters } from "../memory/recall.js";

function rec(id: string, project_tag: string | null) {
  return {
    record_id: id,
    content: "x",
    type: "fact",
    priority: 50,
    scene_name: null,
    skill_tag: null,
    created_time: "2026-05-29T00:00:00Z",
    project_tag,
  } as any;
}

test("scope:project filters by projectTag, NULL-tolerant", () => {
  const records = [rec("a", "proj-1"), rec("b", "proj-2"), rec("c", null)];
  const kept = applyFilters(records, { scope: "project", projectTag: "proj-1" });
  const ids = kept.map((r: any) => r.record_id).sort();
  // proj-1 matches; untagged (c) surfaces (NULL-tolerant); proj-2 excluded.
  assert.deepEqual(ids, ["a", "c"]);
});

test("scope:workspace (default) ignores projectTag", () => {
  const records = [rec("a", "proj-1"), rec("b", "proj-2")];
  const kept = applyFilters(records, { scope: "workspace", projectTag: "proj-1" });
  assert.equal(kept.length, 2);
});

test("projectTag without scope:project is not applied", () => {
  const records = [rec("a", "proj-1"), rec("b", "proj-2")];
  const kept = applyFilters(records, { projectTag: "proj-1" });
  assert.equal(kept.length, 2);
});

test("falls back to the lookup map when the row lacks project_tag", () => {
  const records = [{ record_id: "a", content: "x", type: "fact", priority: 50, created_time: "2026-05-29T00:00:00Z" } as any];
  const lookup = new Map<string, string | null>([["a", "proj-2"]]);
  const kept = applyFilters(records, { scope: "project", projectTag: "proj-1" }, undefined, lookup);
  assert.equal(kept.length, 0); // a is tagged proj-2 via lookup → excluded
});
