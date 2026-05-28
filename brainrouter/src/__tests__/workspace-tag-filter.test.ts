import { describe, expect, it } from "vitest";
import { applyFilters } from "../memory/recall.js";
import type { CognitiveFtsResult } from "@kinqs/brainrouter-types";

/**
 * Unit coverage for the NULL-tolerant workspaceTag filter (FED-S1-T3).
 * Pure function, no sqlite — safe to run under vitest.
 *
 * Contract:
 *   - No filter set → every record passes.
 *   - Filter set + record has no tag (NULL) → record passes (legacy
 *     records remain visible across workspaces during gradual
 *     federation rollout).
 *   - Filter set + record has matching tag → record passes.
 *   - Filter set + record has non-matching tag → record dropped.
 *   - When the record row itself lacks workspace_tag (e.g., it came
 *     from FTS5 which doesn't carry the column), `workspaceTagLookup`
 *     supplies the answer.
 */

const TAG_ALPHA = "1111111111111111";
const TAG_BETA = "2222222222222222";

function fts(record_id: string, workspace_tag?: string | null): CognitiveFtsResult {
  return {
    record_id,
    user_id: "u1",
    content: "",
    type: "codebase_fact",
    priority: 50,
    scene_name: "",
    skill_tag: "",
    score: 0,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "",
    session_id: "",
    metadata_json: "{}",
    created_time: "2026-05-28T00:00:00Z",
    ...(workspace_tag !== undefined ? { workspace_tag } : {}),
  };
}

describe("workspaceTag recall filter (FED-S1-T3)", () => {
  it("passes every record when the filter is not set", () => {
    const records = [fts("a", TAG_ALPHA), fts("b", TAG_BETA), fts("c", null)];
    expect(applyFilters(records, {})).toHaveLength(3);
  });

  it("keeps matching-tagged records and drops mismatched ones", () => {
    const records = [fts("a", TAG_ALPHA), fts("b", TAG_BETA)];
    const out = applyFilters(records, { workspaceTag: TAG_ALPHA });
    expect(out.map((r) => r.record_id)).toEqual(["a"]);
  });

  it("keeps NULL-tagged records (legacy rows surface in every workspace)", () => {
    const records = [fts("a", TAG_ALPHA), fts("b", null)];
    const out = applyFilters(records, { workspaceTag: TAG_ALPHA });
    expect(out.map((r) => r.record_id).sort()).toEqual(["a", "b"]);
  });

  it("falls back to the workspaceTagLookup map when the row carries no inline tag", () => {
    // Records from FTS5 don't carry workspace_tag — the recall pipeline
    // pre-fetches a map and passes it in. Mismatched tag from the map
    // drops the record; NULL or matching keeps it.
    const records = [fts("a"), fts("b"), fts("c")];
    const lookup = new Map<string, string | null>([
      ["a", TAG_ALPHA],
      ["b", TAG_BETA],
      ["c", null],
    ]);
    const out = applyFilters(records, { workspaceTag: TAG_ALPHA }, lookup);
    expect(out.map((r) => r.record_id).sort()).toEqual(["a", "c"]);
  });

  it("treats a missing entry in the lookup map as NULL (record surfaces)", () => {
    const records = [fts("ghost")];
    const out = applyFilters(records, { workspaceTag: TAG_ALPHA }, new Map());
    expect(out).toHaveLength(1);
  });

  it("inline tag on the row beats the lookup map", () => {
    const records = [fts("a", TAG_ALPHA)];
    const lookup = new Map<string, string | null>([["a", TAG_BETA]]);
    // Inline says alpha → matches the filter → kept regardless of map.
    const out = applyFilters(records, { workspaceTag: TAG_ALPHA }, lookup);
    expect(out).toHaveLength(1);
  });

  it("composes with the existing minPriority + types filters", () => {
    const records = [
      fts("a", TAG_ALPHA),
      { ...fts("b", TAG_ALPHA), priority: 5 },
      { ...fts("c", TAG_ALPHA), type: "episodic" },
    ];
    const out = applyFilters(records, {
      workspaceTag: TAG_ALPHA,
      minPriority: 30,
      types: ["codebase_fact"],
    });
    expect(out.map((r) => r.record_id)).toEqual(["a"]);
  });
});
