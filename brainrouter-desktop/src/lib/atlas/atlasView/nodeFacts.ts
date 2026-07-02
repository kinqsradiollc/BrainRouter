/**
 * Atlas view — detail-panel facts for one node.
 *
 * Derives a node's symbols, its layer, and its import neighbours from the
 * graph's edges/layers. Pure + tested.
 */
import type { AtlasGraph, AtlasNode, AtlasNodeType } from "@kinqs/brainrouter-types";

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
