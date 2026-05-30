import { describe, it, expect } from "vitest";
import { gatherRecordRefs, formatRefHint, type RecordRefsStore } from "../memory/recall-refs.js";

/**
 * MEM-17 (0.4.4) — recall expansion refs. A recalled record exposes its precise
 * source chunks (post MEM-15) and a covering tree node, so a client can drill
 * down in one hop instead of issuing a second blind query.
 */

const STORE: RecordRefsStore = {
  getRecordSourceChunks: (_u, recordId) =>
    recordId === "r_linked"
      ? [{ id: "chunk_a" }, { id: "chunk_b" }, { id: "chunk_c" }]
      : [],
  getTreeNodeIdByChunkId: (_u, chunkId) => (chunkId === "chunk_a" ? "tree_x" : null),
};

describe("gatherRecordRefs", () => {
  it("returns the record's source chunk ids + covering tree node", () => {
    expect(gatherRecordRefs(STORE, "u1", "r_linked")).toEqual({
      sourceChunkIds: ["chunk_a", "chunk_b", "chunk_c"],
      treeNodeId: "tree_x",
    });
  });

  it("returns empty refs for a record with no linked provenance", () => {
    expect(gatherRecordRefs(STORE, "u1", "r_unlinked")).toEqual({ sourceChunkIds: [], treeNodeId: null });
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
    expect(gatherRecordRefs({}, "u1", "r")).toEqual({ sourceChunkIds: [], treeNodeId: null });
  });

  it("swallows a throwing store method", () => {
    const s: RecordRefsStore = {
      getRecordSourceChunks: () => {
        throw new Error("boom");
      },
    };
    expect(gatherRecordRefs(s, "u1", "r")).toEqual({ sourceChunkIds: [], treeNodeId: null });
  });
});

describe("formatRefHint", () => {
  it("formats a compact hint, capping shown chunk ids and noting the tree node", () => {
    expect(formatRefHint({ sourceChunkIds: ["chunk_a", "chunk_b", "chunk_c"], treeNodeId: "tree_x" })).toBe(
      "    ↳ source: chunk_a, chunk_b, +1 · tree: tree_x",
    );
  });

  it("omits the tree clause when there is no tree node", () => {
    expect(formatRefHint({ sourceChunkIds: ["chunk_a"], treeNodeId: null })).toBe("    ↳ source: chunk_a");
  });

  it("returns empty string when there are no source chunks", () => {
    expect(formatRefHint({ sourceChunkIds: [], treeNodeId: null })).toBe("");
  });
});
