/**
 * BrainRouter Memory Types — hierarchical memory tree + vault mirror.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ───────────────────────────────────────────────────────────────────────────
// Memory tree (MEM-5, 0.4.3) — durable hierarchical summary over source/topic/
// global scope. Generic mechanics (append leaf → seal bucket → summarize
// parent → walk) are kept separate from policy. Level 0 = leaf.
// ───────────────────────────────────────────────────────────────────────────

export type MemoryTreeKind = "source" | "topic" | "global";

export interface MemoryTreeNode {
  id: string;
  userId: string;
  kind: MemoryTreeKind;
  parentId: string | null;
  level: number;
  summaryMd: string;
  /** Source chunks this node summarizes (leaves cite directly; parents aggregate). */
  sourceChunkIds: string[];
  /** Set once the bucket is sealed (no more leaves appended). */
  sealedAt: string | null;
  heatScore: number;
  createdAt: string;
}

/** Input shape for appending a node — id/createdAt/sealedAt assigned by the store. */
export interface MemoryTreeNodeInput {
  kind: MemoryTreeKind;
  parentId?: string | null;
  level?: number;
  summaryMd: string;
  sourceChunkIds?: string[];
  heatScore?: number;
  /**
   * 0.4.3 (MEM-10) — for scene-derived leaves: the cognitive scene this leaf
   * summarizes. Lets the tree autobuilder dedupe (one leaf per scene) without a
   * content scan. Null for non-scene nodes (sealed parents, source leaves).
   */
  sceneKey?: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Vault mirror (MEM-7, 0.4.3) — a read-only markdown export of records + tree
// nodes, with a hash ledger so re-running only rewrites what changed. The DB
// stays authoritative; the vault is a human-inspectable mirror.
// ───────────────────────────────────────────────────────────────────────────

export type VaultExportKind = "record" | "tree";

export interface VaultExportEntry {
  userId: string;
  /** Vault-relative path, e.g. "records/<id>.md". */
  path: string;
  /** sha256 of the rendered markdown — drives idempotent re-export. */
  hash: string;
  kind: VaultExportKind;
  /** The record / tree-node id this file mirrors. */
  refId: string;
  exportedAt: string;
}

export interface VaultExportInput {
  path: string;
  hash: string;
  kind: VaultExportKind;
  refId: string;
}
