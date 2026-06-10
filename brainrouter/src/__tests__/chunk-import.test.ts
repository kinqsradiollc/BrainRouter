import { describe, it, expect } from "vitest";
import {
  chunkContent,
  chunkParentId,
  expandImportRecord,
  readImportChunkChars,
  IMPORT_CHUNK_DEFAULT_CHARS,
} from "../memory/pipeline/chunk-import.js";

describe("chunkContent", () => {
  it("returns content unchanged when within budget or disabled", () => {
    expect(chunkContent("short", 1500)).toEqual(["short"]);
    const big = "a".repeat(5000);
    expect(chunkContent(big, 0)).toEqual([big]);
  });
  it("splits long content into overlapping windows that cover everything", () => {
    const c = "a".repeat(100) + "b".repeat(100) + "c".repeat(100); // 300
    const parts = chunkContent(c, 120, 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 120)).toBe(true);
    expect(parts[0].startsWith("a")).toBe(true);
    expect(parts[parts.length - 1].endsWith("c")).toBe(true);
  });
});

describe("chunkParentId", () => {
  it("strips the chunk suffix and leaves plain ids alone", () => {
    expect(chunkParentId("sess-1::c0")).toBe("sess-1");
    expect(chunkParentId("sess-1::c12")).toBe("sess-1");
    expect(chunkParentId("sess-1")).toBe("sess-1");
    expect(chunkParentId("a::b::c3")).toBe("a::b");
  });
});

describe("expandImportRecord", () => {
  it("passes short records through unchanged", () => {
    const r = { id: "x", content: "hi", metadata: { a: 1 } };
    expect(expandImportRecord(r, 1500)).toEqual([r]);
  });
  it("chunks long records, preserving parent id + provenance", () => {
    const r = { id: "sess", content: "a".repeat(4000), metadata: { src: "t" } };
    const out = expandImportRecord(r, 1500);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].id).toBe("sess::c0");
    expect(out.every((c) => c.content.length <= 1500)).toBe(true);
    expect(out.every((c) => chunkParentId(c.id) === "sess")).toBe(true);
    expect(out[1].metadata).toMatchObject({ parentRecordId: "sess", chunkIndex: 1, src: "t" });
  });
  it("disabled (maxChars=0) returns the record unchanged", () => {
    const r = { id: "x", content: "a".repeat(4000) };
    expect(expandImportRecord(r, 0)).toEqual([r]);
  });
});

describe("readImportChunkChars", () => {
  it("defaults, parses overrides, and tolerates junk", () => {
    expect(readImportChunkChars({})).toBe(IMPORT_CHUNK_DEFAULT_CHARS);
    expect(readImportChunkChars({ BRAINROUTER_IMPORT_CHUNK_CHARS: "800" })).toBe(800);
    expect(readImportChunkChars({ BRAINROUTER_IMPORT_CHUNK_CHARS: "0" })).toBe(0);
    expect(readImportChunkChars({ BRAINROUTER_IMPORT_CHUNK_CHARS: "junk" })).toBe(IMPORT_CHUNK_DEFAULT_CHARS);
  });
});
