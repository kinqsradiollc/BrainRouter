/**
 * Atlas — graph validation (ATLAS-2)
 *
 * Referential-integrity checks for an {@link AtlasGraph}: unique node ids,
 * every edge endpoint and every layer/tour reference resolves to a real node.
 * Errors are hard (a malformed graph); warnings are advisory (orphans, empty
 * layers) and never block rendering.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";

export interface AtlasValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateAtlasGraph(graph: AtlasGraph): AtlasValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id) { errors.push("node with empty id"); continue; }
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    if (!n.name) warnings.push(`node ${n.id} has no name`);
  }

  const touched = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.source)) errors.push(`edge source not found: ${e.source}`);
    if (!ids.has(e.target)) errors.push(`edge target not found: ${e.target}`);
    touched.add(e.source);
    touched.add(e.target);
  }

  for (const l of graph.layers) {
    for (const id of l.nodeIds) if (!ids.has(id)) warnings.push(`layer ${l.id} references missing node ${id}`);
  }
  for (const t of graph.tour) {
    for (const id of t.nodeIds) if (!ids.has(id)) warnings.push(`tour step ${t.order} references missing node ${id}`);
  }

  const orphans = graph.nodes.filter((n) => !touched.has(n.id)).length;
  if (orphans > 0) warnings.push(`${orphans} orphan node(s) with no edges`);

  return { ok: errors.length === 0, errors, warnings };
}
