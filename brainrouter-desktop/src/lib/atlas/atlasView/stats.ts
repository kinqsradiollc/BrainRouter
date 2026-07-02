/**
 * Project stats (Deep Dive) — a compact, aggregated read of the whole graph for
 * the insights overlay: counts by node type / file category / complexity,
 * languages, frameworks, and the most-connected files. Pure + cheap.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";

export interface AtlasProjectStats {
  nodes: number;
  edges: number;
  layers: number;
  files: number;
  /** node.type -> count (descending). */
  byType: Array<{ key: string; count: number }>;
  /** file category -> count (descending). */
  byCategory: Array<{ key: string; count: number }>;
  /** complexity bucket -> count (simple/moderate/complex order). */
  byComplexity: Array<{ key: string; count: number }>;
  /** detected languages (descending by file count). */
  languages: Array<{ key: string; count: number }>;
  frameworks: string[];
  /** most import-connected files (top 5): name + degree. */
  topConnected: Array<{ id: string; name: string; degree: number }>;
}

function descCounts(m: Map<string, number>): Array<{ key: string; count: number }> {
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** Aggregate whole-graph statistics for the Deep Dive overlay. */
export function atlasProjectStats(graph: AtlasGraph): AtlasProjectStats {
  const byType = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byComplexity = new Map<string, number>();
  const languages = new Map<string, number>();
  let files = 0;

  for (const n of graph.nodes) {
    byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
    if (n.type === "file") {
      files++;
      if (n.language) languages.set(n.language, (languages.get(n.language) ?? 0) + 1);
    }
    if (n.category) byCategory.set(n.category, (byCategory.get(n.category) ?? 0) + 1);
    if (n.complexity) byComplexity.set(n.complexity, (byComplexity.get(n.complexity) ?? 0) + 1);
  }

  // Import-degree per file (in + out), top 5.
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nameById = new Map(graph.nodes.map((n) => [n.id, n.name] as const));
  const topConnected = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, d]) => ({ id, name: nameById.get(id) ?? id, degree: d }));

  const complexityOrder = ["simple", "moderate", "complex"];
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    layers: graph.layers.length,
    files,
    byType: descCounts(byType),
    byCategory: descCounts(byCategory),
    byComplexity: descCounts(byComplexity).sort((a, b) => complexityOrder.indexOf(a.key) - complexityOrder.indexOf(b.key)),
    languages: descCounts(languages),
    frameworks: graph.project.frameworks ?? [],
    topConnected,
  };
}
