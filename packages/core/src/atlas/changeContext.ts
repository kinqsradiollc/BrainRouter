/**
 * ATLAS-UNDERSTANDING — a FREE, deterministic "what does this change touch?" block
 * built purely from the Atlas graph (no LLM call). It maps a set of changed files
 * onto the graph and reports each file's summary + blast radius (how many files
 * depend on it, grouped by layer). Injected into the read-only code-review prompt
 * so the reviewer weighs regression risk with architectural awareness — riding a
 * review the user is already paying for, at zero extra token cost.
 */
import type { AtlasGraph, AtlasNode } from "@kinqs/brainrouter-types";
import { atlasImpact, atlasImpactOf } from "@kinqs/brainrouter-types";

/** File-level node for a path (the `file:` node, not a function/class symbol). */
function fileNodeFor(graph: AtlasGraph, path: string): AtlasNode | undefined {
  return graph.nodes.find((n) => n.filePath === path && n.type !== "function" && n.type !== "class");
}

/**
 * Build a compact markdown "Change impact" block for the given changed paths.
 * Returns "" when there's no graph or none of the changed files are in it — a
 * missing/stale Atlas must never break the review, only enrich it when present.
 */
export function buildAtlasChangeContext(
  graph: AtlasGraph | null | undefined,
  changedPaths: string[],
  opts: { maxFiles?: number } = {},
): string {
  if (!graph || !changedPaths.length) return "";
  const maxFiles = opts.maxFiles ?? 15;
  const matched = changedPaths.map((p) => fileNodeFor(graph, p)).filter((n): n is AtlasNode => !!n).slice(0, maxFiles);
  if (!matched.length) return "";

  const fmtLayers = (byLayer: Array<{ layer: string; count: number }>): string =>
    byLayer.slice(0, 3).map((l) => `${l.layer} (${l.count})`).join(", ");

  const lines = matched.map((n) => {
    const imp = atlasImpact(graph, n.id);
    const dep = imp.dependents.length;
    const summary = n.summary ? ` — ${n.summary}` : "";
    const radius = dep ? ` · ${dep} dependent${dep === 1 ? "" : "s"}${imp.byLayer.length ? ` across ${fmtLayers(imp.byLayer)}` : ""}` : " · no known dependents";
    return `- \`${n.filePath}\`${summary}${radius}`;
  });

  const combined = atlasImpactOf(graph, matched.map((n) => n.id));
  const combinedLine = combined.byLayer.length
    ? `Combined blast radius: ${combined.dependents.length} file(s) depend on these changes, across ${fmtLayers(combined.byLayer)}.`
    : "";

  return [
    "## Change impact (from the codebase Atlas — deterministic, not a guess)",
    ...lines,
    combinedLine,
    "Weigh this when reviewing: edits to widely-depended-on files carry more regression risk — check the dependents listed above for breakage.",
  ].filter(Boolean).join("\n");
}
