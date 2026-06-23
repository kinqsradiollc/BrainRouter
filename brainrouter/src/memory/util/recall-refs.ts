/**
 * MEM-17 (0.4.4) — recall expansion refs.
 *
 * Recall hits used to be flat cards (content/score/type/recordId). Comparable
 * memory systems return expandable ids so a client can drill from a summary to
 * its exact source / tree node without a second blind query. This gathers those
 * handles for a recalled record — its precise source chunks (post MEM-15) and,
 * when one covers them, a memory-tree node — and formats a compact one-hop hint
 * for the briefing block.
 *
 * Pure over a capability-detected store surface (the methods live on
 * SqliteMemoryStore, not IMemoryStore), so it unit-tests with a plain fake.
 */

export interface RecordRefsStore {
  // Capability-detected on the concrete store; backed by either a synchronous
  // store (direct injection / unit fakes) or the asyncified one — accept both
  // and `await` (awaiting a non-Promise is a no-op).
  getRecordSourceChunks?(userId: string, recordId: string): { id: string }[] | Promise<{ id: string }[]>;
  getTreeNodeIdByChunkId?(userId: string, chunkId: string): (string | null) | Promise<string | null>;
  /** MEM-ACCURACY — true when the record's source code changed since capture. */
  isRecordSourceStale?(userId: string, recordId: string): boolean | Promise<boolean>;
}

export interface RecordRefs {
  sourceChunkIds: string[];
  treeNodeId: string | null;
  /** MEM-ACCURACY — the code this record was derived from has since changed. */
  staleVsCode: boolean;
}

/** Gather a record's source-chunk ids + covering tree node. Best-effort: a
 * store missing either capability (or a throwing one) just yields fewer refs. */
export async function gatherRecordRefs(store: RecordRefsStore, userId: string, recordId: string): Promise<RecordRefs> {
  let sourceChunkIds: string[] = [];
  if (typeof store.getRecordSourceChunks === "function") {
    try {
      sourceChunkIds = (await store.getRecordSourceChunks(userId, recordId)).map((c) => c.id);
    } catch {
      sourceChunkIds = [];
    }
  }
  let treeNodeId: string | null = null;
  if (sourceChunkIds.length > 0 && typeof store.getTreeNodeIdByChunkId === "function") {
    try {
      treeNodeId = await store.getTreeNodeIdByChunkId(userId, sourceChunkIds[0]);
    } catch {
      treeNodeId = null;
    }
  }
  // Only code-anchored records can be stale-vs-code; skip the query otherwise.
  let staleVsCode = false;
  if (sourceChunkIds.length > 0 && typeof store.isRecordSourceStale === "function") {
    try {
      staleVsCode = await store.isRecordSourceStale(userId, recordId);
    } catch {
      staleVsCode = false;
    }
  }
  return { sourceChunkIds, treeNodeId, staleVsCode };
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
  // MEM-ACCURACY — make code drift VISIBLE so the agent re-verifies instead of
  // trusting a memory whose underlying file has since changed.
  const stale = refs.staleVsCode ? " · ⚠ source changed since capture — verify against current code" : "";
  return `    ↳ source: ${shown}${more}${tree}${stale}`;
}
