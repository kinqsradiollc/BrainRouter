/**
 * Atlas panel — pure view helpers (ATLAS-5)
 *
 * Turns an AtlasGraph into a renderable, bounded set of file-level nodes +
 * import edges, assigns theme-consistent colours by node type, and computes a
 * force-directed layout. Kept pure (no React, no DOM) so it unit-tests under
 * tsx and the panel stays thin.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { AtlasEdge, AtlasGraph, AtlasNode, AtlasNodeType } from "@kinqs/brainrouter-types";

/** Node types shown in the structural map (symbols — function/class — are detail, hidden here). */
const FILE_LEVEL: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

/**
 * Node-type colours, tuned for the near-black Graphite theme (indigo accent for
 * code files, a restrained spread for the rest — NOT a loud rainbow). Consumed
 * inline so they track the active theme's accent where it matters.
 */
export const ATLAS_NODE_COLORS: Record<string, string> = {
  file: "var(--accent, #4c8dff)",
  module: "#7c93ff",
  config: "#2dd4bf",
  document: "#38bdf8",
  resource: "#fbbf24",
  schema: "#34d399",
  service: "#a78bfa",
  endpoint: "#fb923c",
  pipeline: "#f472b6",
  function: "#5fae74",
  class: "#9b7fc0",
  domain: "#e0a458",
  flow: "#7dd3fc",
  step: "#94a3b8",
};

export function atlasNodeColor(type: AtlasNodeType): string {
  return ATLAS_NODE_COLORS[type] ?? "var(--text-dim, #9d9da6)";
}

export interface AtlasViewNode {
  id: string;
  name: string;
  type: AtlasNodeType;
  filePath?: string;
  /** import-degree (in + out among shown nodes) — drives node size. */
  degree: number;
}

export interface AtlasViewModel {
  nodes: AtlasViewNode[];
  edges: Array<{ source: string; target: string }>;
  /** total file-level nodes in the graph (>= nodes.length when capped). */
  total: number;
  shown: number;
}

/**
 * Build the bounded view model: file-level nodes + import edges, capped to the
 * `limit` most-connected nodes for render performance (deterministic tie-break
 * by id). Returns how many were shown vs total so the panel can flag truncation.
 */
export function atlasViewModel(graph: AtlasGraph, limit = 400): AtlasViewModel {
  const fileLevel = graph.nodes.filter((n) => FILE_LEVEL.has(n.type));
  const fileIds = new Set(fileLevel.map((n) => n.id));

  // import edges among file-level nodes
  const importEdges = graph.edges.filter((e) => e.type === "imports" && fileIds.has(e.source) && fileIds.has(e.target));
  const degree = new Map<string, number>();
  for (const e of importEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const ranked = [...fileLevel].sort((a, b) => {
    const d = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const kept = ranked.slice(0, Math.max(1, limit));
  const keptIds = new Set(kept.map((n) => n.id));

  const nodes: AtlasViewNode[] = kept.map((n: AtlasNode) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    filePath: n.filePath,
    degree: degree.get(n.id) ?? 0,
  }));
  const edges = importEdges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .map((e: AtlasEdge) => ({ source: e.source, target: e.target }));

  return { nodes, edges, total: fileLevel.length, shown: nodes.length };
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/**
 * Compute static x/y positions via a short d3-force simulation. Returns a map
 * id → {x, y}. Runs to a fixed tick count so it's fast + stable for a panel.
 */
export function atlasLayout(model: AtlasViewModel, opts: { width?: number; height?: number; ticks?: number } = {}): Map<string, { x: number; y: number }> {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const ticks = opts.ticks ?? 300;

  const simNodes: SimNode[] = model.nodes.map((n) => ({ id: n.id }));
  const idIndex = new Map(simNodes.map((n, i) => [n.id, i] as const));
  const simLinks = model.edges
    .filter((e) => idIndex.has(e.source) && idIndex.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-120))
    .force("link", forceLink(simLinks).id((d: SimulationNodeDatum) => (d as SimNode).id).distance(70).strength(0.6))
    .force("center", forceCenter(width / 2, height / 2))
    // gentle pull to centre so disconnected nodes (configs, docs, leaf files)
    // don't drift to the edges and shrink the connected core.
    .force("x", forceX(width / 2).strength(0.06))
    .force("y", forceY(height / 2).strength(0.06))
    .force("collide", forceCollide(26))
    .stop();

  for (let i = 0; i < ticks; i++) sim.tick();

  const out = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) out.set(n.id, { x: n.x ?? width / 2, y: n.y ?? height / 2 });
  return out;
}

/** Node render size from import-degree (bounded). */
export function atlasNodeSize(degree: number): number {
  return Math.min(40, 14 + degree * 2);
}

export interface AtlasSymbolRef {
  id: string;
  name: string;
  type: AtlasNodeType;
  lineRange?: [number, number];
}

export interface AtlasNodeFacts {
  node: AtlasNode;
  /** function/class symbols defined in this file (file-level nodes only). */
  symbols: AtlasSymbolRef[];
  /** the layer this node belongs to, if enrichment assigned one. */
  layer?: { id: string; name: string };
  /** file paths this node imports (outgoing) and that import it (incoming). */
  importsOut: string[];
  importsIn: string[];
}

/**
 * Everything the detail panel shows for one node: its symbols, its layer, and
 * its import neighbours — derived from the graph's edges/layers. Pure + tested.
 */
export function atlasNodeFacts(graph: AtlasGraph, nodeId: string): AtlasNodeFacts | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const node = byId.get(nodeId);
  if (!node) return null;

  const symbols: AtlasSymbolRef[] = graph.edges
    .filter((e) => e.type === "contains" && e.source === nodeId)
    .map((e) => byId.get(e.target))
    .filter((n): n is AtlasNode => !!n && (n.type === "function" || n.type === "class"))
    .map((n) => ({ id: n.id, name: n.name, type: n.type, lineRange: n.lineRange }));

  const layerDef = graph.layers.find((l) => l.nodeIds.includes(nodeId));
  const layer = layerDef ? { id: layerDef.id, name: layerDef.name } : undefined;

  const pathOf = (id: string): string => byId.get(id)?.filePath ?? byId.get(id)?.name ?? id;
  const importsOut = graph.edges.filter((e) => e.type === "imports" && e.source === nodeId).map((e) => pathOf(e.target));
  const importsIn = graph.edges.filter((e) => e.type === "imports" && e.target === nodeId).map((e) => pathOf(e.source));

  return { node, symbols, layer, importsOut, importsIn };
}
