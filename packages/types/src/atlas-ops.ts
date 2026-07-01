/**
 * Atlas pure graph operations — query + impact (REMOTE-BRAIN Phase 3b).
 *
 * These depend only on the {@link AtlasGraph} contract, so they live here in the
 * dependency-free `types` package and are shared verbatim by BOTH the desktop
 * renderer (the local Atlas panel) and the brain (server-side `atlas_query` /
 * `atlas_impact` tools over a stored graph). Keeping one implementation avoids a
 * wrong-layer dependency (the brain can't import `core`/desktop) and the drift
 * of two copies. Everything here is pure and deterministic — no I/O, no clock.
 */
import type { AtlasGraph } from "./atlas.js";

/** Ranked node-id matches for a free-text query over name/path/summary/tags. */
export function atlasSearchMatches(graph: AtlasGraph, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const n of graph.nodes) {
    const name = n.name.toLowerCase();
    const path = (n.filePath ?? "").toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (path.includes(q)) score = 40;
    else if ((n.summary ?? "").toLowerCase().includes(q)) score = 20;
    else if ((n.tags ?? []).some((t) => t.toLowerCase().includes(q))) score = 15;
    if (score > 0) scored.push({ id: n.id, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map((s) => s.id);
}

/** The blast radius of an Atlas node (or a changed set): who depends on it + what it depends on. */
export interface AtlasImpact {
  /** Files that import this node directly. */
  directDependents: string[];
  /** Files that import this node directly or transitively (the blast radius). */
  dependents: string[];
  /** Files this node imports, directly or transitively. */
  dependencies: string[];
  /** Dependents grouped by layer name (largest first). */
  byLayer: Array<{ layer: string; count: number }>;
}

function importAdjacency(graph: AtlasGraph): { fwd: Map<string, Set<string>>; rev: Map<string, Set<string>> } {
  const fwd = new Map<string, Set<string>>(); // importer → imported
  const rev = new Map<string, Set<string>>(); // imported → importers
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    (fwd.get(e.source) ?? fwd.set(e.source, new Set()).get(e.source)!).add(e.target);
    (rev.get(e.target) ?? rev.set(e.target, new Set()).get(e.target)!).add(e.source);
  }
  return { fwd, rev };
}

function reach(start: Iterable<string>, adj: Map<string, Set<string>>, exclude: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (out.has(next) || exclude.has(next)) continue;
      out.add(next);
      stack.push(next);
    }
  }
  return [...out];
}

/** Blast radius of a single node: who depends on it (transitively) and what it depends on. */
export function atlasImpact(graph: AtlasGraph, nodeId: string): AtlasImpact {
  const { fwd, rev } = importAdjacency(graph);
  const self = new Set([nodeId]);
  const dependents = reach(self, rev, self);
  const dependencies = reach(self, fwd, self);

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const layerOfNode = new Map<string, string>();
  for (const l of graph.layers) for (const id of l.nodeIds) if (!layerOfNode.has(id)) layerOfNode.set(id, l.name);

  const counts = new Map<string, number>();
  for (const id of dependents) {
    const layer = layerOfNode.get(id) ?? (byId.get(id)?.filePath ? "(unlayered)" : "");
    if (layer) counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  const byLayer = [...counts.entries()].map(([layer, count]) => ({ layer, count })).sort((a, b) => b.count - a.count);

  return { directDependents: [...(rev.get(nodeId) ?? [])], dependents, dependencies, byLayer };
}

/** Combined blast radius of a set of changed nodes (dependents outside the set). */
export function atlasImpactOf(graph: AtlasGraph, nodeIds: Iterable<string>): { dependents: string[]; byLayer: Array<{ layer: string; count: number }> } {
  const { rev } = importAdjacency(graph);
  const seed = new Set(nodeIds);
  const dependents = reach(seed, rev, seed);
  const layerOfNode = new Map<string, string>();
  for (const l of graph.layers) for (const id of l.nodeIds) if (!layerOfNode.has(id)) layerOfNode.set(id, l.name);
  const counts = new Map<string, number>();
  for (const id of dependents) {
    const layer = layerOfNode.get(id) ?? "(unlayered)";
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return { dependents, byLayer: [...counts.entries()].map(([layer, count]) => ({ layer, count })).sort((a, b) => b.count - a.count) };
}
