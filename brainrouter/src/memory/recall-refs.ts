/**
 * MEM-17 (0.4.4) — recall expansion refs.
 *
 * Recall hits used to be flat cards (content/score/type/recordId). agentmemory
 * and OpenHuman return expandable ids so a client can drill from a summary to
 * its exact source / tree node without a second blind query. This gathers those
 * handles for a recalled record — its precise source chunks (post MEM-15) and,
 * when one covers them, a memory-tree node — and formats a compact one-hop hint
 * for the briefing block.
 *
 * Pure over a capability-detected store surface (the methods live on
 * SqliteMemoryStore, not IMemoryStore), so it unit-tests with a plain fake.
 */

export interface RecordRefsStore {
  getRecordSourceChunks?(userId: string, recordId: string): { id: string }[];
  getTreeNodeIdByChunkId?(userId: string, chunkId: string): string | null;
}

export interface RecordRefs {
  sourceChunkIds: string[];
  treeNodeId: string | null;
}

/** Gather a record's source-chunk ids + covering tree node. Best-effort: a
 * store missing either capability (or a throwing one) just yields fewer refs. */
export function gatherRecordRefs(store: RecordRefsStore, userId: string, recordId: string): RecordRefs {
  let sourceChunkIds: string[] = [];
  if (typeof store.getRecordSourceChunks === "function") {
    try {
      sourceChunkIds = store.getRecordSourceChunks(userId, recordId).map((c) => c.id);
    } catch {
      sourceChunkIds = [];
    }
  }
  let treeNodeId: string | null = null;
  if (sourceChunkIds.length > 0 && typeof store.getTreeNodeIdByChunkId === "function") {
    try {
      treeNodeId = store.getTreeNodeIdByChunkId(userId, sourceChunkIds[0]);
    } catch {
      treeNodeId = null;
    }
  }
  return { sourceChunkIds, treeNodeId };
}

/**
 * Compact drill-down hint for a briefing line, e.g.
 *   `    ↳ source: chunk_a, chunk_b, +2 · tree: tree_x`
 * Empty string when the record has no refs (so callers can append unconditionally).
 * Caps the shown chunk ids so a heavily-linked record doesn't bloat the block.
 */
export function formatRefHint(refs: RecordRefs, maxShown = 2): string {
  if (refs.sourceChunkIds.length === 0) return "";
  const shown = refs.sourceChunkIds.slice(0, maxShown).join(", ");
  const more = refs.sourceChunkIds.length > maxShown ? `, +${refs.sourceChunkIds.length - maxShown}` : "";
  const tree = refs.treeNodeId ? ` · tree: ${refs.treeNodeId}` : "";
  return `    ↳ source: ${shown}${more}${tree}`;
}
