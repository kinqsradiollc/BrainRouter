/**
 * Atlas — deterministic base-graph builder (ATLAS-2)
 *
 * Orchestrates the scanner + symbol extractor into a well-formed
 * {@link AtlasGraph}: a node per file, per function, and per class; `contains`
 * edges from files to their symbols; and `imports` edges between files resolved
 * from relative import specifiers. Summaries, tags, layers and the tour are
 * left empty here — LLM enrichment (ATLAS-4) fills them. The result is already
 * a useful, renderable graph on its own.
 */
import fs from "node:fs";
import path from "node:path";
import {
  atlasFileId,
  atlasSymbolId,
  emptyAtlasGraph,
  type AtlasComplexity,
  type AtlasEdge,
  type AtlasFileCategory,
  type AtlasGraph,
  type AtlasLayer,
  type AtlasNode,
  type AtlasNodeType,
} from "@kinqs/brainrouter-types";
import { gitHeadSha } from "../git/workspaceGit.js";
import { scanWorkspace, type ScanOptions } from "./scan.js";
import { extractSymbols } from "./extract.js";

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs", ".vue", ".svelte"];

function complexityForLines(n: number): AtlasComplexity {
  return n < 60 ? "simple" : n < 250 ? "moderate" : "complex";
}

/** Map a file category to its node type. `code`/`script` files are `file` nodes. */
function fileNodeType(category: AtlasFileCategory): AtlasNodeType {
  switch (category) {
    case "config": return "config";
    case "docs": return "document";
    case "markup": return "document";
    case "infra": return "resource";
    case "data": return "schema";
    default: return "file";
  }
}

/** File-level node types that belong to a layer. */
const LAYER_LEVEL: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>(["file", "config", "document", "resource", "schema"]);
const WRAP_DIRS = /\/(src|lib|source|app|dist|build|tests?|__tests__|spec)$/;

/**
 * The architectural "layer" a file belongs to — derived from its path so the
 * graph is legible WITHOUT an LLM. Uses the package/top-two directory, collapsing
 * a wrapper level (…/src). Monorepo: `packages/core`, `brainrouter-desktop`;
 * app: `src/cart`, `src/catalog`.
 */
function layerKeyFor(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  if (dir === "." || dir === "") return "(root)";
  const parts = dir.split("/").filter(Boolean);
  let key = parts.slice(0, 2).join("/");
  key = key.replace(WRAP_DIRS, "");
  return key || parts[0];
}

/** Group file-level nodes into deterministic layers by package/directory. */
function deriveLayers(nodes: AtlasNode[]): AtlasLayer[] {
  const byKey = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.filePath || !LAYER_LEVEL.has(n.type)) continue;
    const key = layerKeyFor(n.filePath);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(n.id);
  }
  return [...byKey.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, ids]) => ({
      id: `layer:${key.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"}`,
      name: key,
      nodeIds: ids,
    }));
}

/** Resolve a RELATIVE import specifier to a known file path, or undefined. */
function resolveRelativeImport(fromRel: string, spec: string, fileSet: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const baseDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  if (fileSet.has(joined)) return joined;
  for (const e of RESOLVE_EXTS) if (fileSet.has(joined + e)) return joined + e;
  for (const e of RESOLVE_EXTS) if (fileSet.has(`${joined}/index${e}`)) return `${joined}/index${e}`;
  return undefined;
}

export interface BuildOptions extends ScanOptions {
  /** Override the build timestamp (tests). Defaults to now. */
  now?: string;
}

/** Build the deterministic Atlas base graph for a workspace. */
export function buildBaseGraph(root: string, opts: BuildOptions = {}): AtlasGraph {
  const scan = scanWorkspace(root, opts);
  const fileSet = new Set(scan.files.map((f) => f.path));

  const graph = emptyAtlasGraph({
    name: scan.name,
    languages: scan.languages,
    frameworks: scan.frameworks,
    description: scan.description,
    analyzedAt: opts.now ?? new Date().toISOString(),
    gitCommitHash: gitHeadSha(root),
    totalFiles: scan.totalFiles,
  });

  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const addEdge = (e: AtlasEdge): void => {
    const k = `${e.source}->${e.target}:${e.type}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    graph.edges.push(e);
  };

  for (const f of scan.files) {
    const fileId = atlasFileId(f.path);
    if (!nodeIds.has(fileId)) {
      nodeIds.add(fileId);
      graph.nodes.push({
        id: fileId,
        type: fileNodeType(f.category),
        name: path.posix.basename(f.path),
        filePath: f.path,
        language: f.language,
        category: f.category,
        complexity: complexityForLines(f.sizeLines),
      });
    }

    if (f.category !== "code") continue;

    let src = "";
    try { src = fs.readFileSync(path.join(root, f.path), "utf8"); } catch { continue; }
    if (!src) continue;

    const sym = extractSymbols(f.language, src);
    for (const c of sym.classes) {
      const id = atlasSymbolId("class", f.path, c.name);
      if (!nodeIds.has(id)) {
        nodeIds.add(id);
        graph.nodes.push({ id, type: "class", name: c.name, filePath: f.path, lineRange: c.lineRange, complexity: complexityForLines(c.lineRange[1] - c.lineRange[0] + 1) });
      }
      addEdge({ source: fileId, target: id, type: "contains", weight: 1 });
    }
    for (const fn of sym.functions) {
      const id = atlasSymbolId("function", f.path, fn.name);
      if (!nodeIds.has(id)) {
        nodeIds.add(id);
        graph.nodes.push({ id, type: "function", name: fn.name, filePath: f.path, lineRange: fn.lineRange, complexity: complexityForLines(fn.lineRange[1] - fn.lineRange[0] + 1) });
      }
      addEdge({ source: fileId, target: id, type: "contains", weight: 1 });
    }
    for (const im of sym.imports) {
      const target = resolveRelativeImport(f.path, im.module, fileSet);
      if (target && target !== f.path) addEdge({ source: fileId, target: atlasFileId(target), type: "imports", weight: 0.9 });
    }
  }

  // Drop edges whose endpoints aren't real nodes (defensive; resolveRelativeImport
  // only yields known files, so this is belt-and-braces).
  graph.edges = graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  // Deterministic layers from the directory/package structure, so Overview /
  // Domain views work immediately — LLM enrichment refines them, isn't required.
  graph.layers = deriveLayers(graph.nodes);
  return graph;
}
