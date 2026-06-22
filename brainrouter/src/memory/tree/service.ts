/**
 * Memory-tree service (ADR-008, Wave 2) — an engine-bound port over the
 * hierarchical summary tree (source → topic → global). The brain's memory
 * subsystems take an injected MemoryEngine rather than a workspaceRoot, so this
 * facade binds the engine at construction. Additive and behaviour-preserving:
 * every method delegates to the existing treeOps functions; no logic moved or
 * removed.
 */
import type { MemoryTreeNode, MemoryTreeKind } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { appendTreeLeaf, summarizeBucket, rollupGlobalTree, treeWalk } from "./treeOps.js";

/** Result of {@link IMemoryTreeService.walk} — the module's exact shape. */
export type TreeWalkResult = ReturnType<typeof treeWalk>;

/** The hierarchical memory-tree contract, bound to one engine. */
export interface IMemoryTreeService {
  appendLeaf(userId: string, kind: MemoryTreeKind, summaryMd: string, sourceChunkIds?: string[], heatScore?: number): MemoryTreeNode | null;
  summarizeBucket(userId: string, childIds: string[], kind: MemoryTreeKind): MemoryTreeNode | null;
  rollupGlobal(userId: string): MemoryTreeNode | null;
  walk(userId: string, nodeId?: string, kind?: MemoryTreeKind): TreeWalkResult;
}

/** {@link IMemoryTreeService} backed by the in-process tree ops — delegates only. */
export class MemoryTreeService implements IMemoryTreeService {
  constructor(private readonly engine: MemoryEngine) {}
  appendLeaf(userId: string, kind: MemoryTreeKind, summaryMd: string, sourceChunkIds?: string[], heatScore?: number): MemoryTreeNode | null {
    return appendTreeLeaf(this.engine, userId, kind, summaryMd, sourceChunkIds ?? [], heatScore ?? 0);
  }
  summarizeBucket(userId: string, childIds: string[], kind: MemoryTreeKind): MemoryTreeNode | null {
    return summarizeBucket(this.engine, userId, childIds, kind);
  }
  rollupGlobal(userId: string): MemoryTreeNode | null {
    return rollupGlobalTree(this.engine, userId);
  }
  walk(userId: string, nodeId?: string, kind?: MemoryTreeKind): TreeWalkResult {
    return treeWalk(this.engine, userId, nodeId, kind);
  }
}

/** Construct a memory-tree service bound to an engine. */
export function createMemoryTreeService(engine: MemoryEngine): IMemoryTreeService {
  return new MemoryTreeService(engine);
}
