/**
 * BrainRouter Memory Types — source documents + token-aware chunks.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ── 0.4.3 Brain Phase 2/3 — source documents + chunks ──────────────────────
// First-class raw-source identity + token-aware chunk boundary, so extracted
// cognitive records can cite exact source chunks (provenance, AST code recall,
// vault mirror, and the memory tree all build on these). User/workspace scope
// columns are present from the start so team/RBAC can arrive without migration.

export type SourceDocumentKind = "transcript" | "file" | "tool_output" | "imported_doc";

export interface SourceDocument {
  id: string;
  userId: string;
  /** 16-char workspace hash (NULL-tolerant, like cognitive records). */
  workspaceTag: string | null;
  kind: SourceDocumentKind;
  /** File path, tool name, or doc URI — null for free-floating transcript turns. */
  uri: string | null;
  /** Content hash; lets re-ingest of the same source be idempotent. */
  hash: string;
  title: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SourceChunk {
  id: string;
  documentId: string;
  /** 0-based position within the document. */
  ordinal: number;
  content: string;
  tokenCount: number;
  /** Set for file/code chunks; null otherwise. */
  filePath: string | null;
  /** AST symbol (function/class/etc.) when known — populated by the AST chunker. */
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
  hash: string;
}

/** Input shape for `addSourceChunks` — ordinal + id + hash are assigned by the store. */
export interface SourceChunkInput {
  content: string;
  tokenCount: number;
  filePath?: string | null;
  symbol?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}
