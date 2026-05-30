import { describe, expect, it } from "vitest";
import {
  attributeRecordToChunks,
  readProvenanceConfig,
  type AttributableChunk,
} from "../memory/source/attribution.js";

/**
 * MEM-15 (0.4.4) — exact chunk-level provenance. These assert that a record is
 * attributed to the chunk(s) it actually derives from, NOT every chunk in the
 * window (the 0.4.3 batch-level over-linking this replaces).
 */

const CHUNKS: AttributableChunk[] = [
  { id: "c_auth", content: "The signin endpoint validates the JWT auth token and rejects expired sessions." },
  { id: "c_db", content: "The database migration adds a created_at index to the cognitive_records table." },
  { id: "c_ui", content: "The dashboard renders the recall history timeline with a virtualized list." },
];

describe("attributeRecordToChunks", () => {
  it("links a record only to the chunk it derives from, not unrelated chunks", () => {
    const ids = attributeRecordToChunks(
      "The signin endpoint rejects expired JWT auth tokens.",
      CHUNKS,
    );
    expect(ids).toEqual(["c_auth"]);
  });

  it("attributes a DB-flavoured record to the DB chunk", () => {
    const ids = attributeRecordToChunks(
      "A created_at index was added to cognitive_records via a database migration.",
      CHUNKS,
    );
    expect(ids).toEqual(["c_db"]);
  });

  it("returns [] when the record shares no salient token with any chunk", () => {
    expect(attributeRecordToChunks("Quarterly revenue grew in the Nordics.", CHUNKS)).toEqual([]);
  });

  it("returns [] for empty record content or empty chunk list", () => {
    expect(attributeRecordToChunks("", CHUNKS)).toEqual([]);
    expect(attributeRecordToChunks("anything", [])).toEqual([]);
  });

  it("can link multiple chunks when the record spans them, capped + best-first", () => {
    const spanning = [
      { id: "c1", content: "alpha beta gamma delta epsilon" },
      { id: "c2", content: "alpha beta gamma zeta eta" },
      { id: "c3", content: "alpha beta theta iota kappa" },
      { id: "c4", content: "totally unrelated content here lorem" },
    ];
    // Record shares alpha/beta/gamma — c1 & c2 score highest, c4 ~0.
    const ids = attributeRecordToChunks("alpha beta gamma", spanning, { floor: 0.3, maxChunks: 2 });
    expect(ids.length).toBe(2);
    expect(ids).not.toContain("c4");
    expect(ids[0]).toBe("c1"); // best (all 3 tokens) first; tie broken by input order
  });

  it("falls back to the single best chunk when none clear the floor", () => {
    const weak = [
      { id: "c_partial", content: "auth token rotation policy notes and many other unrelated words here padding" },
      { id: "c_none", content: "completely different subject matter entirely" },
    ];
    // "auth token" is a small fraction of the record's tokens → below a high floor,
    // but c_partial is still the best match, so it's linked (not nothing, not both).
    const ids = attributeRecordToChunks(
      "Rotate the auth token every ninety days per the security baseline requirement.",
      weak,
      { floor: 0.9, maxChunks: 3 },
    );
    expect(ids).toEqual(["c_partial"]);
  });
});

describe("readProvenanceConfig", () => {
  it("defaults to floor 0.3 / maxChunks 3 with no env", () => {
    expect(readProvenanceConfig({})).toEqual({ floor: 0.3, maxChunks: 3 });
  });

  it("honours valid env overrides", () => {
    expect(
      readProvenanceConfig({ BRAINROUTER_PROVENANCE_FLOOR: "0.5", BRAINROUTER_PROVENANCE_MAX_CHUNKS: "1" }),
    ).toEqual({ floor: 0.5, maxChunks: 1 });
  });

  it("falls back to defaults on invalid/out-of-range env", () => {
    expect(
      readProvenanceConfig({ BRAINROUTER_PROVENANCE_FLOOR: "2", BRAINROUTER_PROVENANCE_MAX_CHUNKS: "0" }),
    ).toEqual({ floor: 0.3, maxChunks: 3 });
    expect(
      readProvenanceConfig({ BRAINROUTER_PROVENANCE_FLOOR: "abc", BRAINROUTER_PROVENANCE_MAX_CHUNKS: "xyz" }),
    ).toEqual({ floor: 0.3, maxChunks: 3 });
  });
});
