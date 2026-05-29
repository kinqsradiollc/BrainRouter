import { describe, expect, it } from "vitest";
import { buildProvenanceView } from "../tools/provenance-view.js";
import type { CognitiveRecord, MemoryEvidence } from "@kinqs/brainrouter-types";

function rec(over: Partial<CognitiveRecord>): CognitiveRecord {
  return {
    id: "rec-1",
    userId: "u1",
    sessionKey: "s",
    sessionId: "s",
    content: "The auth module uses JWT with a 15-minute access token.",
    type: "codebase_fact",
    priority: 50,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    timestampStr: "",
    timestampStart: "",
    timestampEnd: "",
    createdTime: "2026-05-29T00:00:00.000Z",
    updatedTime: "2026-05-29T00:00:00.000Z",
    metadata: {},
    confidence: 0.9,
    status: "active",
    sourceKind: "source_file",
    verificationStatus: "verified",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 3,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
    ...over,
  };
}

const ev = (kind: MemoryEvidence["kind"], ref: string): MemoryEvidence => ({
  id: "e",
  userId: "u1",
  recordId: "rec-1",
  kind,
  ref,
  excerpt: "",
  observedAt: "2026-05-29T00:00:00.000Z",
  metadata: {},
});

describe("MAS-P6-T2 buildProvenanceView", () => {
  it("assembles an active record with evidence and no successor", () => {
    const v = buildProvenanceView("rec-1", rec({}), [ev("file", "src/auth.ts"), ev("test", "auth.test.ts")], null);
    expect(v.found).toBe(true);
    expect(v.active).toBe(true);
    expect(v.sourceKind).toBe("source_file");
    expect(v.verificationStatus).toBe("verified");
    expect(v.citationCount).toBe(3);
    expect(v.evidence).toEqual([
      { kind: "file", ref: "src/auth.ts" },
      { kind: "test", ref: "auth.test.ts" },
    ]);
    expect(v.supersededBy).toBeNull();
    expect(v.contentPreview).toMatch(/JWT/);
  });

  it("marks superseded records inactive and includes the successor preview", () => {
    const v = buildProvenanceView(
      "rec-1",
      rec({ supersededBy: "rec-2", status: "superseded" }),
      [],
      rec({ id: "rec-2", content: "Auth now uses 30-minute tokens." }),
    );
    expect(v.active).toBe(false);
    expect(v.supersededBy?.recordId).toBe("rec-2");
    expect(v.supersededBy?.preview).toMatch(/30-minute/);
  });

  it("handles a superseded record whose successor wasn't found", () => {
    const v = buildProvenanceView("rec-1", rec({ supersededBy: "gone" }), [], null);
    expect(v.supersededBy?.preview).toMatch(/successor not found/);
  });

  it("returns found:false for a missing record", () => {
    const v = buildProvenanceView("nope", null, [], null);
    expect(v.found).toBe(false);
    expect(v.recordId).toBe("nope");
    expect(v.evidence).toEqual([]);
  });
});
