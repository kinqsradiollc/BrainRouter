/**
 * Overview mode — layer cards + inter-layer import edges.
 *
 * Rolls the graph's enrichment layers into cards (file counts + aggregate
 * complexity) and computes the undirected import edges between them, with an
 * optional Top-N rollup into a single "Other" card for very large repos.
 */
import type { AtlasComplexity, AtlasGraph, AtlasNode } from "@kinqs/brainrouter-types";
import { GROUPABLE } from "./shared.js";

export interface AtlasOverviewCard {
  id: string;
  name: string;
  description?: string;
  fileCount: number;
  complexity: AtlasComplexity;
  nodeIds: string[];
}

export interface AtlasOverviewModel {
  cards: AtlasOverviewCard[];
  edges: Array<{ source: string; target: string; weight: number }>;
}

/** Roll a set of nodes up into a single dominant complexity bucket. */
export function aggregateComplexity(nodes: AtlasNode[]): AtlasComplexity {
  const c = { simple: 0, moderate: 0, complex: 0 };
  for (const n of nodes) c[n.complexity ?? "simple"]++;
  if (c.complex > 0 && c.complex >= c.moderate && c.complex >= c.simple) return "complex";
  if (c.moderate > 0 && c.moderate >= c.simple) return "moderate";
  return "simple";
}

/** Synthetic id for the rolled-up "Other" Overview card. */
export const ATLAS_OVERVIEW_OTHER_ID = "layer:__other";

/**
 * Layer cards + inter-layer import edges, for the Overview mode.
 *
 * `limit` (default `Infinity` — no rollup, preserving prior behaviour and the
 * Domain mode's edge usage) caps the card count for very large repos: the
 * `limit - 1` biggest layers are kept and the rest fold into a single "Other"
 * card, with their edges remapped onto it (self-loops dropped, weights summed).
 */
export function atlasOverviewModel(graph: AtlasGraph, limit = Infinity): AtlasOverviewModel {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const layerOf = new Map<string, string>();
  for (const l of graph.layers) for (const id of l.nodeIds) if (!layerOf.has(id)) layerOf.set(id, l.id);

  let cards: AtlasOverviewCard[] = graph.layers.map((l) => {
    const nodes = l.nodeIds.map((id) => byId.get(id)).filter((n): n is AtlasNode => !!n && GROUPABLE.has(n.type));
    return { id: l.id, name: l.name, description: l.description, fileCount: nodes.length, complexity: aggregateComplexity(nodes), nodeIds: l.nodeIds };
  });

  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const a = layerOf.get(e.source);
    const b = layerOf.get(e.target);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let edges = [...counts.entries()].map(([k, weight]) => {
    const [source, target] = k.split("|");
    return { source, target, weight };
  });

  if (Number.isFinite(limit) && cards.length > limit) {
    const sorted = [...cards].sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
    const keep = sorted.slice(0, Math.max(1, limit - 1));
    const fold = sorted.slice(Math.max(1, limit - 1));
    const keepIds = new Set(keep.map((c) => c.id));
    const otherNodeIds = fold.flatMap((c) => c.nodeIds);
    const other: AtlasOverviewCard = {
      id: ATLAS_OVERVIEW_OTHER_ID,
      name: "Other",
      description: `${fold.length} smaller layers`,
      fileCount: fold.reduce((s, c) => s + c.fileCount, 0),
      complexity: aggregateComplexity(otherNodeIds.map((id) => byId.get(id)).filter((n): n is AtlasNode => !!n)),
      nodeIds: otherNodeIds,
    };
    cards = [...keep, other];

    const map = (id: string): string => (keepIds.has(id) ? id : ATLAS_OVERVIEW_OTHER_ID);
    const merged = new Map<string, number>();
    for (const e of edges) {
      const s = map(e.source);
      const t = map(e.target);
      if (s === t) continue;
      const key = s < t ? `${s}|${t}` : `${t}|${s}`;
      merged.set(key, (merged.get(key) ?? 0) + e.weight);
    }
    edges = [...merged.entries()].map(([k, weight]) => {
      const [source, target] = k.split("|");
      return { source, target, weight };
    });
  }

  return { cards, edges };
}
