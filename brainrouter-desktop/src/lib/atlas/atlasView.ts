/**
 * Atlas panel — pure view helpers (ATLAS-5)
 *
 * Turns an AtlasGraph into a renderable, bounded set of file-level nodes +
 * import edges, assigns theme-consistent colours by node type, and computes a
 * force-directed layout. Kept pure (no React, no DOM) so it unit-tests under
 * tsx and the panel stays thin.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { AtlasComplexity, AtlasEdge, AtlasFileCategory, AtlasGraph, AtlasNode, AtlasNodeType } from "@kinqs/brainrouter-types";
// Pure query + impact ops moved to the shared `types` package (REMOTE-BRAIN
// Phase 3b) so the brain can reuse them server-side. Re-exported here so the
// panel + existing tests keep importing them from atlasView unchanged.
// Import from the atlas-ops SUBPATH, not the package barrel: the barrel's
// `export *` pulls `memory.js`, whose top-level `node:crypto` import breaks the
// browser (vite) bundle. atlas-ops only depends on the pure `atlas.js` types.
export { atlasSearchMatches, atlasImpact, atlasImpactOf, type AtlasImpact } from "@kinqs/brainrouter-types/dist/atlas-ops.js";

/** Node types shown in the structural map (symbols — function/class — are detail, hidden here). */
const FILE_LEVEL: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

/**
 * Node-type colours, tuned for the near-black Graphite theme (indigo accent for
 * code files, a restrained spread for the rest — NOT a loud rainbow). Consumed
 * inline so they track the active theme's accent where it matters.
 */
export const ATLAS_NODE_COLORS: Record<string, string> = {
  file: "var(--accent, #4c8dff)",
  module: "#7c93ff",
  config: "#2dd4bf",
  document: "#38bdf8",
  resource: "#fbbf24",
  schema: "#34d399",
  service: "#a78bfa",
  endpoint: "#fb923c",
  pipeline: "#f472b6",
  function: "#5fae74",
  class: "#9b7fc0",
  domain: "#e0a458",
  flow: "#7dd3fc",
  step: "#94a3b8",
};

export function atlasNodeColor(type: AtlasNodeType): string {
  return ATLAS_NODE_COLORS[type] ?? "var(--text-dim, #9d9da6)";
}

export interface AtlasViewNode {
  id: string;
  name: string;
  type: AtlasNodeType;
  filePath?: string;
  /** import-degree (in + out among shown nodes) — drives node size. */
  degree: number;
}

export interface AtlasViewModel {
  nodes: AtlasViewNode[];
  edges: Array<{ source: string; target: string }>;
  /** total file-level nodes in the graph (>= nodes.length when capped). */
  total: number;
  shown: number;
}

/**
 * Build the bounded view model: file-level nodes + import edges, capped to the
 * `limit` most-connected nodes for render performance (deterministic tie-break
 * by id). Returns how many were shown vs total so the panel can flag truncation.
 */
export function atlasViewModel(graph: AtlasGraph, limit = 400): AtlasViewModel {
  const fileLevel = graph.nodes.filter((n) => FILE_LEVEL.has(n.type));
  const fileIds = new Set(fileLevel.map((n) => n.id));

  // import edges among file-level nodes
  const importEdges = graph.edges.filter((e) => e.type === "imports" && fileIds.has(e.source) && fileIds.has(e.target));
  const degree = new Map<string, number>();
  for (const e of importEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const ranked = [...fileLevel].sort((a, b) => {
    const d = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const kept = ranked.slice(0, Math.max(1, limit));
  const keptIds = new Set(kept.map((n) => n.id));

  const nodes: AtlasViewNode[] = kept.map((n: AtlasNode) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    filePath: n.filePath,
    degree: degree.get(n.id) ?? 0,
  }));
  const edges = importEdges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .map((e: AtlasEdge) => ({ source: e.source, target: e.target }));

  return { nodes, edges, total: fileLevel.length, shown: nodes.length };
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/**
 * Compute static x/y positions via a short d3-force simulation. Returns a map
 * id → {x, y}. Runs to a fixed tick count so it's fast + stable for a panel.
 */
export function atlasLayout(model: AtlasViewModel, opts: { width?: number; height?: number; ticks?: number } = {}): Map<string, { x: number; y: number }> {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const ticks = opts.ticks ?? 300;

  const simNodes: SimNode[] = model.nodes.map((n) => ({ id: n.id }));
  const idIndex = new Map(simNodes.map((n, i) => [n.id, i] as const));
  const simLinks = model.edges
    .filter((e) => idIndex.has(e.source) && idIndex.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-120))
    .force("link", forceLink(simLinks).id((d: SimulationNodeDatum) => (d as SimNode).id).distance(70).strength(0.6))
    .force("center", forceCenter(width / 2, height / 2))
    // gentle pull to centre so disconnected nodes (configs, docs, leaf files)
    // don't drift to the edges and shrink the connected core.
    .force("x", forceX(width / 2).strength(0.06))
    .force("y", forceY(height / 2).strength(0.06))
    .force("collide", forceCollide(26))
    .stop();

  for (let i = 0; i < ticks; i++) sim.tick();

  const out = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) out.set(n.id, { x: n.x ?? width / 2, y: n.y ?? height / 2 });
  return out;
}

/** Node render size from import-degree (bounded). */
export function atlasNodeSize(degree: number): number {
  return Math.min(40, 14 + degree * 2);
}

export interface AtlasSymbolRef {
  id: string;
  name: string;
  type: AtlasNodeType;
  lineRange?: [number, number];
}

export interface AtlasNodeFacts {
  node: AtlasNode;
  /** function/class symbols defined in this file (file-level nodes only). */
  symbols: AtlasSymbolRef[];
  /** the layer this node belongs to, if enrichment assigned one. */
  layer?: { id: string; name: string };
  /** file paths this node imports (outgoing) and that import it (incoming). */
  importsOut: string[];
  importsIn: string[];
}

/**
 * Rank node ids matching a search query (name > path > summary > tags),
 * case-insensitive. Empty query → no matches. Pure + tested.
 */
/**
 * Everything the detail panel shows for one node: its symbols, its layer, and
 * its import neighbours — derived from the graph's edges/layers. Pure + tested.
 */
export function atlasNodeFacts(graph: AtlasGraph, nodeId: string): AtlasNodeFacts | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const node = byId.get(nodeId);
  if (!node) return null;

  const symbols: AtlasSymbolRef[] = graph.edges
    .filter((e) => e.type === "contains" && e.source === nodeId)
    .map((e) => byId.get(e.target))
    .filter((n): n is AtlasNode => !!n && (n.type === "function" || n.type === "class"))
    .map((n) => ({ id: n.id, name: n.name, type: n.type, lineRange: n.lineRange }));

  const layerDef = graph.layers.find((l) => l.nodeIds.includes(nodeId));
  const layer = layerDef ? { id: layerDef.id, name: layerDef.name } : undefined;

  const pathOf = (id: string): string => byId.get(id)?.filePath ?? byId.get(id)?.name ?? id;
  const importsOut = graph.edges.filter((e) => e.type === "imports" && e.source === nodeId).map((e) => pathOf(e.target));
  const importsIn = graph.edges.filter((e) => e.type === "imports" && e.target === nodeId).map((e) => pathOf(e.source));

  return { node, symbols, layer, importsOut, importsIn };
}

// ---------------------------------------------------------------------------
// Grouped structural view (ATLAS-10) — files clustered into containers, the way
// the eye actually parses a codebase: by architectural layer when the graph is
// enriched, else by directory. Plus a layer-card Overview and category filters.
// ---------------------------------------------------------------------------

/** File-level node types rendered as boxes (symbols stay in the detail card). */
const GROUPABLE: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

/** The file categories shown as filter pills, in display order. */
export const ATLAS_FILE_CATEGORIES: readonly AtlasFileCategory[] = ["code", "config", "docs", "infra", "data", "markup", "script"];

export const ATLAS_CATEGORY_COLORS: Record<AtlasFileCategory, string> = {
  code: "var(--accent, #4c8dff)",
  config: "#2dd4bf",
  docs: "#38bdf8",
  infra: "#a78bfa",
  data: "#34d399",
  markup: "#fbbf24",
  script: "#fb923c",
};

export interface AtlasGroup {
  id: string;
  label: string;
  nodeIds: string[];
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * Group file-level nodes — by enrichment layer when present, else by parent
 * directory. `scope`, if given, restricts to those node ids (drill-in).
 */
export function atlasGrouping(graph: AtlasGraph, scope?: ReadonlySet<string>): AtlasGroup[] {
  const files = graph.nodes.filter((n) => GROUPABLE.has(n.type) && (!scope || scope.has(n.id)));
  if (graph.layers.length) {
    const fileIds = new Set(files.map((n) => n.id));
    const groups: AtlasGroup[] = [];
    const claimed = new Set<string>();
    for (const layer of graph.layers) {
      const ids = layer.nodeIds.filter((id) => fileIds.has(id) && !claimed.has(id));
      ids.forEach((id) => claimed.add(id));
      if (ids.length) groups.push({ id: layer.id, label: layer.name, nodeIds: ids });
    }
    const orphans = files.filter((n) => !claimed.has(n.id)).map((n) => n.id);
    if (orphans.length) groups.push({ id: "group:other", label: "Other", nodeIds: orphans });
    return groups;
  }
  const byDir = new Map<string, string[]>();
  for (const n of files) {
    const dir = dirOf(n.filePath ?? n.name);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(n.id);
  }
  return [...byDir.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([dir, ids]) => ({ id: `group:${dir || "root"}`, label: dir || "(root)", nodeIds: ids }));
}

export interface AtlasGroupBox {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface AtlasGroupedLayout {
  groups: AtlasGroupBox[];
  /** node id → position RELATIVE to its parent group (React Flow child coords). */
  positions: Map<string, { x: number; y: number }>;
  /** node id → group id. */
  groupOf: Map<string, string>;
}

export interface GroupedLayoutOpts {
  nodeW?: number;
  nodeH?: number;
  gap?: number;
  pad?: number;
  titleH?: number;
  groupGap?: number;
  maxRowWidth?: number;
  maxCols?: number;
}

/**
 * Tidy, deterministic grid-pack: each group lays its nodes in a grid; group
 * boxes flow left-to-right and wrap. No physics — clusters read as clean cards.
 */
export function atlasGroupedLayout(groups: AtlasGroup[], opts: GroupedLayoutOpts = {}): AtlasGroupedLayout {
  const nodeW = opts.nodeW ?? 152;
  const nodeH = opts.nodeH ?? 34;
  const gap = opts.gap ?? 14;
  const pad = opts.pad ?? 16;
  const titleH = opts.titleH ?? 34;
  const groupGap = opts.groupGap ?? 40;
  const explicitRowWidth = opts.maxRowWidth;
  const maxCols = opts.maxCols ?? 6;

  const positions = new Map<string, { x: number; y: number }>();
  const groupOf = new Map<string, string>();

  const sized = groups.map((g) => {
    const n = Math.max(1, g.nodeIds.length);
    const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n))));
    const rows = Math.ceil(n / cols);
    const width = cols * nodeW + (cols - 1) * gap + pad * 2;
    const height = titleH + rows * nodeH + (rows - 1) * gap + pad * 2;
    g.nodeIds.forEach((id, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      positions.set(id, { x: pad + c * (nodeW + gap), y: titleH + pad + r * (nodeH + gap) });
      groupOf.set(id, g.id);
    });
    return { g, width, height };
  });

  // Wrap width: an explicit value wins; otherwise aim for a roughly-square
  // overall layout so large/unenriched graphs don't stack into a tall column
  // (but never narrower than the widest single group).
  const totalArea = sized.reduce((s, x) => s + x.width * x.height, 0);
  const widest = sized.reduce((m, x) => Math.max(m, x.width), 0);
  const maxRowWidth = explicitRowWidth ?? Math.max(widest, Math.ceil(Math.sqrt(totalArea) * 1.6));

  const boxes: AtlasGroupBox[] = [];
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const { g, width, height } of sized) {
    if (cx > 0 && cx + width > maxRowWidth) {
      cx = 0;
      cy += rowH + groupGap;
      rowH = 0;
    }
    boxes.push({ id: g.id, label: g.label, x: cx, y: cy, width, height, count: g.nodeIds.length });
    cx += width + groupGap;
    rowH = Math.max(rowH, height);
  }
  return { groups: boxes, positions, groupOf };
}

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

function aggregateComplexity(nodes: AtlasNode[]): AtlasComplexity {
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

// ---------------------------------------------------------------------------
// Review overlay (ATLAS-11) — map git working-tree changes onto the graph so an
// engineer can SEE where the (often AI-authored) edits landed before committing.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Domain deep-dive (ATLAS-12) — read the codebase as business capabilities, not
// files: each layer becomes a capability card with its key entities (classes)
// and the number of guided-tour flows that pass through it, wired by the
// cross-capability dependency edges.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Impact / blast-radius (ATLAS-13) — "if I change this, what's affected?".
// Dependents = everything that (transitively) imports a node; dependencies =
// everything it imports. The review answer understand-anything can't give: the
// downstream reach of an AI edit before you commit it.
// ---------------------------------------------------------------------------

// `AtlasImpact`, `atlasImpact` + `atlasImpactOf` now live in the shared `types`
// package (re-exported at the top of this file) so the brain reuses them.

// ---------------------------------------------------------------------------
// Test coverage (ATLAS-15) — does anything test this file? A deterministic
// signal that's gold for reviewing AI edits: "the AI changed payment.ts and
// nothing covers it." A file counts as covered if a test file imports it or a
// name-adjacent test (foo.test.ts next to foo.ts) exists.
// ---------------------------------------------------------------------------

/** True for typical test file paths (*.test.* / *.spec.* / under __tests__/tests). */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec|node-test)\.[cm]?[jt]sx?$/.test(path);
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(test|spec|node-test)$/, "");
}

/**
 * Code file node ids that have NO test covering them. A file is covered if a
 * test file imports it, or a test file shares its base name.
 */
export function atlasUncoveredFiles(graph: AtlasGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const codeFiles = graph.nodes.filter((n) => n.type === "file" && n.category === "code" && n.filePath && !isTestFile(n.filePath));
  const testBaseNames = new Set<string>();
  for (const n of graph.nodes) if (n.filePath && isTestFile(n.filePath)) testBaseNames.add(baseName(n.filePath));

  // files imported by a test file
  const importedByTest = new Set<string>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const src = byId.get(e.source);
    if (src?.filePath && isTestFile(src.filePath)) importedByTest.add(e.target);
  }

  const uncovered = new Set<string>();
  for (const f of codeFiles) {
    const covered = importedByTest.has(f.id) || testBaseNames.has(baseName(f.filePath!));
    if (!covered) uncovered.add(f.id);
  }
  return uncovered;
}

// ---------------------------------------------------------------------------
// Service map (ADR-008, Wave 3) — read the codebase as the decomposed service
// architecture: each module that exposes a typed PORT (`<module>/service.ts`, or
// the provider `gateway.ts`) becomes a service card, wired by the imports that
// cross module boundaries. Deterministic + build-time — no enrichment needed —
// so the multi-service decomposition self-documents in Atlas.
// ---------------------------------------------------------------------------

/** A service-port facade file: `service.ts`, or the provider `gateway.ts`. */
const SERVICE_FILE_RE = /(?:^|\/)(?:service|gateway)\.ts$/;

/** True when a path is a service-port facade (not a `*-service.test.ts`). */
export function isServicePortPath(path: string): boolean {
  return SERVICE_FILE_RE.test(path);
}

/** Readable module label: the directory after the package's `src/`, minus the filename. */
export function serviceModuleLabel(path: string): string {
  return path.replace(/^(?:.*\/)?src\//, "").replace(/\/(?:service|gateway)\.ts$/, "");
}

export interface AtlasServiceCard {
  /** `service:<dir>` — the port file's directory. */
  id: string;
  /** Readable module name, e.g. `"exec"`, `"memory/tree"`. */
  module: string;
  /** Workspace-relative path to the port file. */
  portPath: string;
  /** The port file's node id (for selection / detail). */
  portNodeId: string;
  /** File-level nodes that make up the module (same directory as the port). */
  nodeIds: string[];
  fileCount: number;
}

export interface AtlasServiceModel {
  cards: AtlasServiceCard[];
  /** Directed module→module import edges (source imports target), weighted. */
  edges: Array<{ source: string; target: string; weight: number }>;
}

/**
 * Service cards (one per module exposing a port) + the directed import edges
 * between them. A file belongs to the module of the port file in its directory.
 * Pure + deterministic; file-level nodes only (a symbol sharing the port's path
 * is never double-counted).
 */
export function atlasServiceModel(graph: AtlasGraph): AtlasServiceModel {
  const ports = graph.nodes.filter(
    (n) => GROUPABLE.has(n.type) && n.filePath && isServicePortPath(n.filePath),
  );

  const cards: AtlasServiceCard[] = [];
  const seenDir = new Set<string>();
  const fileModule = new Map<string, string>(); // file node id → card id

  for (const port of ports) {
    const dir = dirOf(port.filePath!);
    if (seenDir.has(dir)) continue; // one card per module dir (first port wins)
    seenDir.add(dir);
    const id = `service:${dir}`;
    const members = graph.nodes.filter(
      (n) => GROUPABLE.has(n.type) && n.filePath && dirOf(n.filePath) === dir,
    );
    members.forEach((m) => fileModule.set(m.id, id));
    cards.push({
      id,
      module: serviceModuleLabel(port.filePath!),
      portPath: port.filePath!,
      portNodeId: port.id,
      nodeIds: members.map((m) => m.id),
      fileCount: members.length,
    });
  }

  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const a = fileModule.get(e.source);
    const b = fileModule.get(e.target);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const edges = [...counts.entries()].map(([k, weight]) => {
    const [source, target] = k.split(" ");
    return { source, target, weight };
  });

  cards.sort((a, b) => a.module.localeCompare(b.module));
  return { cards, edges };
}

// `atlasImpactOf` moved to the shared `types` package (re-exported above).
