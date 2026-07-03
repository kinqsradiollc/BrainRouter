/**
 * Atlas — graph persistence (ATLAS-3)
 *
 * The built {@link AtlasGraph} is stored per-workspace in the CLI state dir
 * (alongside requirements/artifacts/etc.), so the CLI `/atlas` command writes
 * it and the desktop host reads the SAME artifact — one source of truth.
 * Pure functions of `workspaceRoot` for trivial testability.
 */
import { createHash } from "node:crypto";
import { isAtlasGraph, type AtlasGraph } from "@kinqs/brainrouter-types";
import { getStateFile, readJsonFile, writeJsonFile } from "../../storage/store.js";

/** Absolute path to the workspace's Atlas graph artifact. */
export function atlasGraphFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, "atlas-graph.json");
}

/**
 * Stable per-workspace tag for brain-side Atlas storage (`atlas_put`/`atlas_get`),
 * REMOTE-BRAIN Phase 3d. The same absolute `workspaceRoot` always maps to the same
 * tag, so the CLI and the desktop sync the one graph for a workspace. Shape:
 * `<basename-slug>-<12-hex>` — human-readable + collision-resistant.
 */
export function atlasWorkspaceTag(workspaceRoot: string): string {
  const base =
    (workspaceRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "workspace")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

/** Persist the graph for a workspace (overwrites the previous build). */
export function saveAtlasGraph(workspaceRoot: string, graph: AtlasGraph): void {
  writeJsonFile(atlasGraphFile(workspaceRoot), graph);
}

/** Load the workspace's Atlas graph, or null if absent / malformed. */
export function readAtlasGraph(workspaceRoot: string): AtlasGraph | null {
  const raw = readJsonFile<unknown>(atlasGraphFile(workspaceRoot), null);
  return isAtlasGraph(raw) ? raw : null;
}

/** Compact stats for a graph — for the CLI summary + desktop badges. */
export function atlasGraphStats(graph: AtlasGraph): {
  files: number;
  functions: number;
  classes: number;
  nodes: number;
  edges: number;
  layers: number;
  enriched: boolean;
} {
  let files = 0, functions = 0, classes = 0;
  for (const n of graph.nodes) {
    if (n.type === "file") files++;
    else if (n.type === "function") functions++;
    else if (n.type === "class") classes++;
  }
  const enriched = graph.nodes.some((n) => !!n.summary) || graph.layers.length > 0 || graph.tour.length > 0;
  return { files, functions, classes, nodes: graph.nodes.length, edges: graph.edges.length, layers: graph.layers.length, enriched };
}
