import type { MemoryTreeNode } from "@kinqs/brainrouter-types";

/**
 * 0.4.3 (MEM-5) — generic memory-tree mechanics, deliberately kept SEPARATE
 * from policy (which the engine owns: when to seal, how source/topic/global
 * relate). These are pure helpers over already-loaded nodes so they unit-test
 * without a store or an LLM.
 */

/** A parent sits one level above its highest child. Empty → level 0 (degenerate). */
export function parentLevel(children: Pick<MemoryTreeNode, "level">[]): number {
  return children.reduce((max, c) => Math.max(max, c.level), -1) + 1;
}

/** Union of the children's cited source chunks, order-preserving + de-duped. */
export function aggregateChunkIds(children: Pick<MemoryTreeNode, "sourceChunkIds">[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of children) {
    for (const id of c.sourceChunkIds) {
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

/**
 * Deterministic default summarizer: a bulleted roll-up of child summaries,
 * truncated to a budget. Swap in an LLM summarizer later without changing the
 * tree mechanics — this keeps `summarizeBucket` testable and offline-safe.
 */
export function summarizeChildren(children: Pick<MemoryTreeNode, "summaryMd">[], maxChars = 1200): string {
  const bullets = children
    .map((c) => c.summaryMd.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((s) => `- ${s}`);
  const joined = bullets.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

/** Heat rolls up additively (a parent is as "hot" as the work beneath it). */
export function aggregateHeat(children: Pick<MemoryTreeNode, "heatScore">[]): number {
  return children.reduce((sum, c) => sum + (c.heatScore || 0), 0);
}
