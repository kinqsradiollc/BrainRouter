import { describe, expect, it } from "vitest";
import { applyFilters } from "../memory/recall.js";
import type { CognitiveFtsResult } from "@kinqs/brainrouter-types";

/**
 * ARTIFACT-LINK / ANNOTATION-LINK — session-scoped recall.
 *
 * Artifacts + annotations captured into the cognitive graph (metadata.kind
 * 'artifact' | 'annotation') are PRIVATE to the chat session that produced them:
 * they must only surface in that session's recall/briefing, never another's.
 * Every other record stays user-global (the cross-session BrainRouter default).
 * Pure function, no sqlite — safe under vitest.
 */

function rec(record_id: string, kind: string | undefined, session_key: string): CognitiveFtsResult {
  return {
    record_id,
    user_id: "u1",
    content: "",
    type: kind === "annotation" ? "review_comment" : kind === "artifact" ? "artifact_reference" : "codebase_fact",
    priority: 50,
    scene_name: "",
    skill_tag: "",
    score: 0,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key,
    session_id: "",
    metadata_json: kind ? JSON.stringify({ kind }) : "{}",
    created_time: "2026-06-20T00:00:00Z",
  };
}

describe("session-scoped recall (artifact/annotation isolation)", () => {
  it("keeps an artifact record only for its origin session", () => {
    const records = [rec("art", "artifact", "s1")];
    expect(applyFilters(records, undefined, undefined, undefined, "s1").map((r) => r.record_id)).toEqual(["art"]);
    expect(applyFilters(records, undefined, undefined, undefined, "s2")).toHaveLength(0);
  });

  it("keeps an annotation record only for its origin session", () => {
    const records = [rec("anno", "annotation", "s1")];
    expect(applyFilters(records, undefined, undefined, undefined, "s1").map((r) => r.record_id)).toEqual(["anno"]);
    expect(applyFilters(records, undefined, undefined, undefined, "s2")).toHaveLength(0);
  });

  it("drops session-scoped records when no session context is given", () => {
    const records = [rec("art", "artifact", "s1"), rec("anno", "annotation", "s1")];
    expect(applyFilters(records, undefined, undefined, undefined, undefined)).toHaveLength(0);
    expect(applyFilters(records, undefined, undefined, undefined, "")).toHaveLength(0);
  });

  it("leaves general (non-artifact/annotation) records user-global regardless of session", () => {
    const records = [rec("fact", undefined, "sX")];
    expect(applyFilters(records, undefined, undefined, undefined, "s1").map((r) => r.record_id)).toEqual(["fact"]);
    expect(applyFilters(records, undefined, undefined, undefined, undefined).map((r) => r.record_id)).toEqual(["fact"]);
  });

  it("isolates per session across a mixed candidate set", () => {
    const records = [
      rec("art-s1", "artifact", "s1"),
      rec("art-s2", "artifact", "s2"),
      rec("anno-s1", "annotation", "s1"),
      rec("fact", undefined, "s2"),
    ];
    const out = applyFilters(records, undefined, undefined, undefined, "s1").map((r) => r.record_id).sort();
    // s1's artifact + annotation + the global fact; NOT s2's artifact.
    expect(out).toEqual(["anno-s1", "art-s1", "fact"]);
  });

  it("still applies the session rule alongside other filters (e.g. minPriority)", () => {
    const lowPri = { ...rec("art-low", "artifact", "s1"), priority: 10 };
    const out = applyFilters([lowPri], { minPriority: 50 }, undefined, undefined, "s1");
    expect(out).toHaveLength(0); // dropped by minPriority even though session matches
  });
});
