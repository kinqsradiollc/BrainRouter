/**
 * Domain deep-dive (ATLAS-12) — read the codebase as business capabilities, not
 * files: each layer becomes a capability card with its key entities (classes)
 * and the number of guided-tour flows that pass through it, wired by the
 * cross-capability dependency edges.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { GROUPABLE } from "./shared.js";
import { atlasOverviewModel } from "./overview.js";

export interface AtlasDomainCard {
  id: string;
  name: string;
  description?: string;
  /** Key entity names (classes defined in the capability's files). */
  entities: string[];
  /** Guided-tour flows that pass through this capability. */
  flows: number;
  fileCount: number;
}

export interface AtlasDomainModel {
  cards: AtlasDomainCard[];
  /** `label` = the LLM relationship verb (from graph.layerEdges) when enriched. */
  edges: Array<{ source: string; target: string; weight: number; label?: string }>;
}

/** Capability cards (from layers) enriched with entities + flow counts + edges. */
export function atlasDomainModel(graph: AtlasGraph): AtlasDomainModel {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const layerOfNode = new Map<string, string>();
  const layerOfPath = new Map<string, string>();
  for (const l of graph.layers) for (const id of l.nodeIds) {
    if (!layerOfNode.has(id)) layerOfNode.set(id, l.id);
    const fp = byId.get(id)?.filePath;
    if (fp && !layerOfPath.has(fp)) layerOfPath.set(fp, l.id);
  }

  const entitiesByLayer = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type !== "class" || !n.filePath) continue;
    const layer = layerOfPath.get(n.filePath);
    if (!layer) continue;
    const arr = entitiesByLayer.get(layer) ?? [];
    if (arr.length < 6 && !arr.includes(n.name)) arr.push(n.name);
    entitiesByLayer.set(layer, arr);
  }

  const flowsByLayer = new Map<string, number>();
  for (const step of graph.tour) {
    const seen = new Set<string>();
    for (const id of step.nodeIds) { const l = layerOfNode.get(id); if (l) seen.add(l); }
    for (const l of seen) flowsByLayer.set(l, (flowsByLayer.get(l) ?? 0) + 1);
  }

  const cards: AtlasDomainCard[] = graph.layers.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    entities: entitiesByLayer.get(l.id) ?? [],
    flows: flowsByLayer.get(l.id) ?? 0,
    fileCount: l.nodeIds.filter((id) => byId.has(id) && GROUPABLE.has(byId.get(id)!.type)).length,
  }));

  // Attach semantic relationship labels (from the enrichment relationship pass)
  // to the (undirected) overview edges — match either direction.
  const labelByPair = new Map<string, string>();
  for (const le of graph.layerEdges ?? []) {
    labelByPair.set(`${le.source}|${le.target}`, le.label);
    if (!labelByPair.has(`${le.target}|${le.source}`)) labelByPair.set(`${le.target}|${le.source}`, le.label);
  }
  const edges = atlasOverviewModel(graph).edges.map((e) => {
    const label = labelByPair.get(`${e.source}|${e.target}`);
    return label ? { ...e, label } : e;
  });

  return { cards, edges };
}
