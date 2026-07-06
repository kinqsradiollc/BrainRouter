/**
 * Atlas panel — pure graph→React-Flow model builders.
 *
 * The heavy per-mode layout logic extracted out of AtlasPanel so the panel
 * component stays a thin composition. Every function here is pure: it takes the
 * atlas graph + the current view state and returns React Flow nodes/edges (or an
 * intermediate structural layout). No React, no side effects.
 */
import type { Edge, Node } from "@xyflow/react";
import type { AtlasFileCategory, AtlasGraph, AtlasNode } from "@kinqs/brainrouter-types";
import {
  atlasGrouping, atlasGroupedLayout, capAtlasGroups, atlasOverviewModel, atlasDomainModel, atlasServiceModel, atlasNodeColor, ATLAS_CATEGORY_COLORS,
  type AtlasChangeKind,
} from "../../lib/atlas/atlasView.js";
import { layeredLayout } from "../../lib/atlas/layeredLayout.js";

export type Mode = "overview" | "structural" | "domain" | "services" | "screens";

/** Max file nodes the top-level Structural view renders before summarizing the
 *  rest as "+N more files". Keeps a large repo a readable wide band instead of a
 *  thousand-node strip; drilling into a single layer shows it in full. */
export const STRUCTURAL_NODE_CAP = 240;

export function fileColor(n: AtlasNode): string {
  if (n.category && ATLAS_CATEGORY_COLORS[n.category]) return ATLAS_CATEGORY_COLORS[n.category];
  return atlasNodeColor(n.type);
}

export function getDynamicMaxWidth(
  containerW: number,
  containerH: number,
  cardCount: number,
  cardW: number,
  cardH: number,
  nodesep: number,
  ranksep: number,
): number {
  const maxPossibleW = Math.max(cardW, Math.min(1080, containerW - 64));
  if (cardCount <= 1) return maxPossibleW;
  const cellW = cardW + nodesep;
  const cellH = cardH + ranksep;
  const totalArea = cardCount * cellW * cellH;
  const aspect = Math.max(0.7, Math.min(1.5, containerW / Math.max(1, containerH)));
  const targetW = Math.sqrt(totalArea * aspect);
  return Math.max(cardW, Math.min(maxPossibleW, targetW));
}

export interface StructuralModel {
  layout: ReturnType<typeof atlasGroupedLayout>;
  visible: Set<string>;
  hidden: number;
  hiddenGroups: number;
}

export function buildStructuralModel(
  graph: AtlasGraph,
  scope: ReadonlySet<string> | undefined,
  disabledCats: ReadonlySet<AtlasFileCategory>,
  containerW: number,
  containerH: number,
): StructuralModel {
  const catScope = new Set(
    graph.nodes.filter((n) => (!scope || scope.has(n.id)) && (!n.category || !disabledCats.has(n.category))).map((n) => n.id),
  );
  // Cap the top-level (all-groups) view to a legible number of file nodes so a
  // big repo reads as a wide band, not a thousand-node strip. Drilling into a
  // single layer (scope set) shows that layer in full.
  const { groups, hidden, hiddenGroups } = capAtlasGroups(
    atlasGrouping(graph, catScope),
    scope ? Infinity : STRUCTURAL_NODE_CAP,
  );
  const visible = new Set<string>();
  for (const g of groups) for (const id of g.nodeIds) visible.add(id);
  return {
    layout: atlasGroupedLayout(groups, {
      containerWidth: containerW,
      containerHeight: containerH,
      maxCols: 4,
    }),
    visible,
    hidden,
    hiddenGroups,
  };
}

export interface RfModel {
  rfNodes: Node[];
  rfEdges: Edge[];
}

export interface BuildRfModelArgs {
  graph: AtlasGraph;
  effMode: Mode;
  overview: ReturnType<typeof atlasOverviewModel> | null;
  domain: ReturnType<typeof atlasDomainModel> | null;
  serviceModel: ReturnType<typeof atlasServiceModel> | null;
  structural: StructuralModel | null;
  byId: Map<string, AtlasNode>;
  showDiff: boolean;
  nodeChanges: Map<string, AtlasChangeKind>;
  containerW: number;
  containerH: number;
}

export function buildRfModel(args: BuildRfModelArgs): RfModel {
  const { graph, effMode, overview, domain, serviceModel, structural, byId, showDiff, nodeChanges, containerW, containerH } = args;
  if (effMode === "overview" && overview) {
    const cardW = 268;
    const cardH = 152;
    const nodesep = 44;
    const ranksep = 84;
    const maxWidth = getDynamicMaxWidth(containerW, containerH, overview.cards.length, cardW, cardH, nodesep, ranksep);
    const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
    const pos = layeredLayout(overview.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), overview.edges, { maxWidth, nodesep, ranksep });
    const nodes: Node[] = overview.cards.map((c, i) => ({
      id: c.id,
      type: "atlasLayer",
      position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
      data: {
        name: c.name, description: c.description, fileCount: c.fileCount, complexity: c.complexity,
        changed: showDiff ? c.nodeIds.filter((id) => nodeChanges.has(id)).length : 0,
      },
      style: { width: cardW },
    }));
    const edges: Edge[] = overview.edges.map((e, i) => ({
      id: `oe${i}`, source: e.source, target: e.target, type: "smoothstep",
      style: { stroke: "var(--border-strong)", strokeWidth: 1 }, label: e.weight > 1 ? String(e.weight) : undefined,
    }));
    return { rfNodes: nodes, rfEdges: edges };
  }
  if (effMode === "domain" && domain) {
    const cardW = 264;
    const cardH = 168;
    const nodesep = 48;
    const ranksep = 90;
    const maxWidth = getDynamicMaxWidth(containerW, containerH, domain.cards.length, cardW, cardH, nodesep, ranksep);
    const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
    const pos = layeredLayout(domain.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), domain.edges, { maxWidth, nodesep, ranksep });
    const nodes: Node[] = domain.cards.map((c, i) => ({
      id: c.id, type: "atlasDomain",
      position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
      data: { name: c.name, description: c.description, entities: c.entities, flows: c.flows },
      style: { width: cardW },
    }));
    // Relationship edges between capabilities: labelled with the LLM relationship
    // verb when the graph is enriched (e.g. "calls", "reads from"), else the
    // import count. Width/opacity track how many imports cross the boundary.
    const maxW = Math.max(1, ...domain.edges.map((e) => e.weight));
    const edges: Edge[] = domain.edges.map((e, i) => ({
      id: `de${i}`, source: e.source, target: e.target, type: "smoothstep", animated: true,
      label: e.label ?? `${e.weight}`,
      labelStyle: { fill: "var(--text-dim)", fontSize: 9 },
      labelBgStyle: { fill: "var(--surface)" },
      labelBgPadding: [3, 1] as [number, number],
      style: { stroke: "var(--accent)", strokeOpacity: 0.45 + 0.45 * (e.weight / maxW), strokeWidth: 1 + 1.5 * (e.weight / maxW) },
    }));
    return { rfNodes: nodes, rfEdges: edges };
  }
  if (effMode === "services" && serviceModel) {
    const cardW = 230;
    const cardH = 132;
    const nodesep = 40;
    const ranksep = 82;
    const maxWidth = getDynamicMaxWidth(containerW, containerH, serviceModel.cards.length, cardW, cardH, nodesep, ranksep);
    const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
    const outC = new Map<string, number>();
    const inC = new Map<string, number>();
    for (const e of serviceModel.edges) {
      outC.set(e.source, (outC.get(e.source) ?? 0) + 1);
      inC.set(e.target, (inC.get(e.target) ?? 0) + 1);
    }
    const pos = layeredLayout(serviceModel.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), serviceModel.edges, { maxWidth, nodesep, ranksep });
    const nodes: Node[] = serviceModel.cards.map((c, i) => ({
      id: c.id, type: "atlasService",
      position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
      data: { module: c.module, portPath: c.portPath, portNodeId: c.portNodeId, fileCount: c.fileCount, dependsOn: outC.get(c.id) ?? 0, dependedOnBy: inC.get(c.id) ?? 0 },
      style: { width: cardW },
    }));
    const maxW = Math.max(1, ...serviceModel.edges.map((e) => e.weight));
    const edges: Edge[] = serviceModel.edges.map((e, i) => ({
      id: `sve${i}`, source: e.source, target: e.target, type: "smoothstep", animated: true,
      style: { stroke: "var(--accent)", strokeOpacity: 0.4 + 0.5 * (e.weight / maxW), strokeWidth: 1 + 1.5 * (e.weight / maxW) },
    }));
    return { rfNodes: nodes, rfEdges: edges };
  }
  if (effMode === "structural" && structural) {
    const { layout, visible } = structural;
    const changedPerGroup = new Map<string, number>();
    if (showDiff) for (const id of nodeChanges.keys()) {
      const g = layout.groupOf.get(id);
      if (g) changedPerGroup.set(g, (changedPerGroup.get(g) ?? 0) + 1);
    }
    const groupNodes: Node[] = layout.groups.map((b) => ({
      id: b.id, type: "atlasGroup", position: { x: b.x, y: b.y },
      data: { label: b.label, count: b.count, changed: changedPerGroup.get(b.id) ?? 0 },
      style: { width: b.width, height: b.height }, selectable: false, draggable: false, zIndex: 0,
    }));
    const fileNodes: Node[] = [];
    for (const [id, pos] of layout.positions) {
      const n = byId.get(id);
      if (!n) continue;
      fileNodes.push({
        id, type: "atlasFile", parentId: layout.groupOf.get(id), extent: "parent", position: pos,
        data: { label: n.name, color: fileColor(n) },
      });
    }
    const edges: Edge[] = [];
    let count = 0;
    for (const e of graph.edges) {
      if (e.type !== "imports" || !visible.has(e.source) || !visible.has(e.target)) continue;
      if (++count > 500) break; // perf cap on very large graphs
      edges.push({ id: `se${edges.length}`, source: e.source, target: e.target, style: { stroke: "var(--border)", strokeWidth: 1 } });
    }
    return { rfNodes: [...groupNodes, ...fileNodes], rfEdges: edges };
  }
  return { rfNodes: [], rfEdges: [] };
}
