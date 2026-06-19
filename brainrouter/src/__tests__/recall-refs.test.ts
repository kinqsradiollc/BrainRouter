import { describe, it, expect } from "vitest";
import { gatherRecordRefs, formatRefHint, type RecordRefsStore } from "../memory/util/recall-refs.js";

/**
 * MEM-17 (0.4.4) — recall expansion refs. A recalled record exposes its precise
 * source chunks (post MEM-15) and a covering tree node, so a client can drill
 * down in one hop instead of issuing a second blind query.
 *
 * MEM-ACCURACY (0.4.7) — refs also carry `staleVsCode`: the source code a record
 * was derived from has changed since capture (its provenance document is stale).
 */

const STORE: RecordRefsStore = {
  getRecordSourceChunks: (_u, recordId) =>
    recordId === "r_linked" || recordId === "r_stale"
      ? [{ id: "chunk_a" }, { id: "chunk_b" }, { id: "chunk_c" }]
      : [],
  getTreeNodeIdByChunkId: (_u, chunkId) => (chunkId === "chunk_a" ? "tree_x" : null),
  isRecordSourceStale: (_u, recordId) => recordId === "r_stale",
};

describe("gatherRecordRefs", () => {
  it("returns the record's source chunk ids + covering tree node (fresh)", () => {
    expect(gatherRecordRefs(STORE, "u1", "r_linked")).toEqual({
      sourceChunkIds: ["chunk_a", "chunk_b", "chunk_c"],
      treeNodeId: "tree_x",
      staleVsCode: false,
    });
  });

  it("flags staleVsCode when the record's provenance document changed", () => {
    expect(gatherRecordRefs(STORE, "u1", "r_stale")).toEqual({
      sourceChunkIds: ["chunk_a", "chunk_b", "chunk_c"],
      treeNodeId: "tree_x",
      staleVsCode: true,
    });
  });

  it("never queries staleness for a record with no code provenance", () => {
    let staleLookups = 0;
    const s: RecordRefsStore = {
      getRecordSourceChunks: () => [],
      isRecordSourceStale: () => {
        staleLookups++;
        return true;
      },
    };
    expect(gatherRecordRefs(s, "u1", "r").staleVsCode).toBe(false);
    expect(staleLookups).toBe(0);
  });

  it("returns empty refs for a record with no linked provenance", () => {
    expect(gatherRecordRefs(STORE, "u1", "r_unlinked")).toEqual({ sourceChunkIds: [], treeNodeId: null, staleVsCode: false });
  });

  it("does not look up a tree node when there are no source chunks", () => {
    let treeLookups = 0;
    const s: RecordRefsStore = {
      getRecordSourceChunks: () => [],
      getTreeNodeIdByChunkId: () => {
        treeLookups++;
        return "tree_x";
      },
    };
    expect(gatherRecordRefs(s, "u1", "r").treeNodeId).toBeNull();
    expect(treeLookups).toBe(0);
  });

  it("degrades gracefully when the store lacks the capabilities", () => {
    expect(gatherRecordRefs({}, "u1", "r")).toEqual({ sourceChunkIds: [], treeNodeId: null, staleVsCode: false });
  });

  it("swallows a throwing store method", () => {
    const s: RecordRefsStore = {
      getRecordSourceChunks: () => {
        throw new Error("boom");
      },
    };
    expect(gatherRecordRefs(s, "u1", "r")).toEqual({ sourceChunkIds: [], treeNodeId: null, staleVsCode: false });
  });

  it("swallows a throwing staleness check (fails fresh)", () => {
    const s: RecordRefsStore = {
      getRecordSourceChunks: () => [{ id: "chunk_a" }],
      isRecordSourceStale: () => {
        throw new Error("boom");
      },
    };
    expect(gatherRecordRefs(s, "u1", "r").staleVsCode).toBe(false);
  });
});

describe("formatRefHint", () => {
  it("formats a compact hint, capping shown chunk ids and noting the tree node", () => {
    expect(formatRefHint({ sourceChunkIds: ["chunk_a", "chunk_b", "chunk_c"], treeNodeId: "tree_x", staleVsCode: false })).toBe(
      "    ↳ source: chunk_a, chunk_b, +1 · tree: tree_x",
    );
  });

  it("omits the tree clause when there is no tree node", () => {
    expect(formatRefHint({ sourceChunkIds: ["chunk_a"], treeNodeId: null, staleVsCode: false })).toBe("    ↳ source: chunk_a");
  });

  it("appends a verify warning when the source changed since capture", () => {
    const hint = formatRefHint({ sourceChunkIds: ["chunk_a"], treeNodeId: "tree_x", staleVsCode: true });
    expect(hint).toContain("↳ source: chunk_a · tree: tree_x");
    expect(hint).toContain("⚠ source changed since capture — verify against current code");
  });

  it("returns empty string when there are no source chunks", () => {
    expect(formatRefHint({ sourceChunkIds: [], treeNodeId: null, staleVsCode: false })).toBe("");
  });
});
