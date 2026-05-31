import type { MemoryTreeNode, MemoryTreeNodeInput, MemoryTreeKind } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { summarizeChildren, aggregateChunkIds, aggregateHeat, parentLevel } from "./tree.js";
import { readTreePolicy, treeAutobuildEnabled } from "./policy.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.6) — the memory-tree engine operations, extracted
 * verbatim from MemoryEngine as free functions taking the engine instance
 * (type-only import → no runtime cycle). `engine.ts`'s methods are now thin
 * wrappers delegating here. No behavior change.
 */

/** The store cast to its tree surface, or null when unavailable. */
function tStore(engine: MemoryEngine): {
  appendTreeNode(userId: string, input: MemoryTreeNodeInput): MemoryTreeNode;
  getTreeNode(id: string): MemoryTreeNode | null;
  getTreeChildren(parentId: string): MemoryTreeNode[];
  getTreeRoots(userId: string, kind?: MemoryTreeKind): MemoryTreeNode[];
  setTreeParent(childIds: string[], parentId: string): void;
  sealTreeNode(id: string): void;
} | null {
  const s = engine.store as any;
  return typeof s.appendTreeNode === "function" && typeof s.getTreeRoots === "function" ? s : null;
}

/** MEM-5 — append a leaf (level 0) summarizing some source chunks. */
export function appendTreeLeaf(engine: MemoryEngine, userId: string, kind: MemoryTreeKind, summaryMd: string, sourceChunkIds: string[] = [], heatScore = 0): MemoryTreeNode | null {
  const store = tStore(engine);
  return store ? store.appendTreeNode(userId, { kind, level: 0, summaryMd, sourceChunkIds, heatScore }) : null;
}

/** MEM-5 — seal a bucket: roll the given children into a summarized parent. */
export function summarizeBucket(engine: MemoryEngine, userId: string, childIds: string[], kind: MemoryTreeKind): MemoryTreeNode | null {
  const store = tStore(engine);
  if (!store) return null;
  const children = childIds.map((id) => store.getTreeNode(id)).filter((n): n is MemoryTreeNode => !!n);
  if (children.length === 0) return null;
  const parent = store.appendTreeNode(userId, {
    kind,
    level: parentLevel(children),
    summaryMd: summarizeChildren(children),
    sourceChunkIds: aggregateChunkIds(children),
    heatScore: aggregateHeat(children),
  });
  store.setTreeParent(childIds, parent.id);
  for (const c of children) store.sealTreeNode(c.id);
  return parent;
}

/**
 * BRAIN-P4-T5 — global rollup digest. Once enough unsealed global roots
 * accumulate (`BRAINROUTER_TREE_GLOBAL_ROLLUP`, default 3) this rolls them up
 * into ONE higher global digest. Reuses summarizeBucket; gated like autobuild.
 */
export function rollupGlobalTree(engine: MemoryEngine, userId: string): MemoryTreeNode | null {
  if (!treeAutobuildEnabled()) return null;
  const store = engine.store as any;
  if (typeof store.getTreeRoots !== "function") return null;
  const roots = (store.getTreeRoots(userId, "global") as MemoryTreeNode[]).filter((n) => !n.sealedAt);
  if (roots.length < readTreePolicy().globalRollupThreshold) return null;
  return summarizeBucket(engine, userId, roots.map((n) => n.id), "global");
}

/** MEM-5 / MEM-8 — walk the tree: a node + its children, or the roots of a kind. */
export function treeWalk(engine: MemoryEngine, userId: string, nodeId?: string, kind?: MemoryTreeKind): { node: MemoryTreeNode | null; children: MemoryTreeNode[]; roots?: MemoryTreeNode[] } {
  const store = tStore(engine);
  if (!store) return { node: null, children: [] };
  if (nodeId) {
    const node = store.getTreeNode(nodeId);
    return { node, children: node ? store.getTreeChildren(nodeId) : [] };
  }
  return { node: null, children: [], roots: store.getTreeRoots(userId, kind) };
}
