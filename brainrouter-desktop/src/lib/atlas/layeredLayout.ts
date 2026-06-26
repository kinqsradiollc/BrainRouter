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
  /** Wrap overly wide top-bottom ranks to this content width. */
  maxWidth?: number;
}

function layoutWidth(pos: Map<string, { x: number; y: number }>, nodes: LayeredNodeInput[]): number {
  if (pos.size === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + n.width);
  }
  return Number.isFinite(minX) && Number.isFinite(maxX) ? maxX - minX : 0;
}

function compactWideTopBottomRanks(
  pos: Map<string, { x: number; y: number }>,
  nodes: LayeredNodeInput[],
  opts: Required<Pick<LayeredLayoutOptions, "nodesep" | "ranksep">> & { maxWidth: number },
): Map<string, { x: number; y: number }> {
  if (layoutWidth(pos, nodes) <= opts.maxWidth) return pos;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const placed = [...pos.entries()]
    .map(([id, p]) => ({ id, x: p.x, y: p.y, node: byId.get(id)! }))
    .filter((r) => r.node)
    .sort((a, b) => (Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x));

  const ranks: typeof placed[] = [];
  for (const item of placed) {
    const last = ranks[ranks.length - 1];
    if (!last || Math.abs(last[0].y - item.y) > 28) ranks.push([item]);
    else last.push(item);
  }

  const out = new Map<string, { x: number; y: number }>();
  let y = 24;
  for (const rank of ranks) {
    rank.sort((a, b) => a.x - b.x);
    const widest = Math.max(1, ...rank.map((r) => r.node.width));
    const cols = Math.max(1, Math.floor((opts.maxWidth + opts.nodesep) / (widest + opts.nodesep)));
    let rankHeight = 0;
    for (let start = 0; start < rank.length; start += cols) {
      const row = rank.slice(start, start + cols);
      const rowW = row.reduce((sum, r) => sum + r.node.width, 0) + Math.max(0, row.length - 1) * opts.nodesep;
      const rowH = Math.max(...row.map((r) => r.node.height));
      let x = Math.max(0, (opts.maxWidth - rowW) / 2);
      for (const r of row) {
        out.set(r.id, { x, y: y + rankHeight });
        x += r.node.width + opts.nodesep;
      }
      rankHeight += rowH + opts.nodesep;
    }
    y += Math.max(0, rankHeight - opts.nodesep) + opts.ranksep;
  }
  return out;
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
  if (opts.maxWidth && (opts.rankdir ?? "TB") === "TB") {
    return compactWideTopBottomRanks(pos, nodes, { maxWidth: opts.maxWidth, nodesep: opts.nodesep ?? 60, ranksep: opts.ranksep ?? 96 });
  }
  return pos;
}
