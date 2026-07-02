/**
 * Review overlay (ATLAS-11) — map git working-tree changes onto the graph so an
 * engineer can SEE where the (often AI-authored) edits landed before committing.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { GROUPABLE } from "./shared.js";

export type AtlasChangeKind = "added" | "modified" | "untracked" | "deleted";

/** LLM assessment of one uncommitted change (ATLAS-14). */
export interface AtlasChangeAssessment {
  summary: string;
  risk: "low" | "medium" | "high";
  checklist: string[];
  concerns: string[];
}

/** Map a git porcelain status code (e.g. "M", "A", "??", "AM") to a change kind. */
export function atlasChangeKind(status: string): AtlasChangeKind | null {
  const s = (status ?? "").trim();
  if (!s) return null;
  if (s === "??") return "untracked";
  if (s.includes("D")) return "deleted";
  if (s.includes("A")) return "added";
  if (s.includes("M") || s.includes("R") || s.includes("C") || s.includes("U")) return "modified";
  return "modified";
}

/** path → change kind, for the files git reports as changed. */
export function atlasChangeMap(changed: ReadonlyArray<{ path: string; status: string }>): Map<string, AtlasChangeKind> {
  const out = new Map<string, AtlasChangeKind>();
  for (const c of changed ?? []) {
    const k = atlasChangeKind(c.status);
    if (k) out.set(c.path, k);
  }
  return out;
}

/** node id → change kind (only for nodes whose filePath is in the change map). */
export function atlasNodeChanges(graph: AtlasGraph, changeMap: Map<string, AtlasChangeKind>): Map<string, AtlasChangeKind> {
  const out = new Map<string, AtlasChangeKind>();
  if (changeMap.size === 0) return out;
  for (const n of graph.nodes) {
    // Only file-level nodes carry the change badge — a symbol shares its file's
    // path but must not be double-counted.
    if (GROUPABLE.has(n.type) && n.filePath && changeMap.has(n.filePath)) out.set(n.id, changeMap.get(n.filePath)!);
  }
  return out;
}
