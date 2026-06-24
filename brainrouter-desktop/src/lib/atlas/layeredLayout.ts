/**
 * Layered (hierarchical) DAG layout for the Atlas card modes (Overview / Domain
 * / Services). Positions cards top-down by their dependency edges via dagre, so
 * sources sit above the things they depend on — a clean Sugiyama layering rather
 * than a flat grid. React Flow wants top-left positions; dagre returns centres,
 * so we offset by half the node size.
 */
import dagre from "@dagrejs/dagre";

export interface LayeredNodeInput {
  id: string;
  width: number;
  height: number;
}
export interface LayeredEdgeInput {
  source: string;
  target: string;
}

export interface LayeredLayoutOptions {
  /** "TB" top→bottom (default) or "LR" left→right. */
  rankdir?: "TB" | "LR";
  /** Gap between nodes in the same rank. */
  nodesep?: number;
  /** Gap between ranks. */
  ranksep?: number;
}

/**
 * Returns id → {x,y} (top-left). Nodes with no incident edges are still placed
 * by dagre (own rank). Returns an empty map when there are no edges — callers
 * should fall back to a grid in that case (a single dagre rank is just a long row).
 */
export function layeredLayout(
  nodes: LayeredNodeInput[],
  edges: LayeredEdgeInput[],
  opts: LayeredLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0 || edges.length === 0) return pos;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: opts.rankdir ?? "TB",
    nodesep: opts.nodesep ?? 60,
    ranksep: opts.ranksep ?? 96,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target) && e.source !== e.target) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  for (const n of nodes) {
    const dn = g.node(n.id) as { x: number; y: number } | undefined;
    if (dn) pos.set(n.id, { x: dn.x - n.width / 2, y: dn.y - n.height / 2 });
  }
  return pos;
}
