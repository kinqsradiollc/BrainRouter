/**
 * BrainRouter Atlas — codebase knowledge graph (0.4.16)
 *
 * An Atlas turns a workspace into an explorable knowledge graph: every file,
 * function, class, config, document and service is a NODE; structural and
 * semantic relationships are EDGES; nodes are grouped into architectural
 * LAYERS; and an ordered TOUR walks the codebase in dependency order so a
 * newcomer learns it in the right sequence.
 *
 * The graph is built by a pipeline (deterministic scan + symbol extraction,
 * then optional LLM enrichment) and persisted as a single JSON artifact the
 * CLI writes and the desktop "Atlas" panel renders.
 *
 * This is the stable, dependency-free contract shared by the core builder, the
 * CLI command, the desktop renderer, and (later) MCP tools. camelCase keys,
 * plain-`string` ids, ISO-8601 timestamps — matching the rest of this package.
 */

/** Current Atlas graph schema version (for migrate-on-read). */
export const ATLAS_SCHEMA_VERSION = 1;

/**
 * What an Atlas node represents.
 * - Code:    `file` `function` `class` `module`
 * - Artifact: `config` `document` `service` `endpoint` `schema` `resource` `pipeline`
 * - Domain (business-logic view): `domain` `flow` `step`
 */
export type AtlasNodeType =
  | "file"
  | "function"
  | "class"
  | "module"
  | "config"
  | "document"
  | "service"
  | "endpoint"
  | "schema"
  | "resource"
  | "pipeline"
  | "domain"
  | "flow"
  | "step";

/** Relationship kinds between nodes. */
export type AtlasEdgeType =
  // structural
  | "contains"
  | "imports"
  | "exports"
  | "inherits"
  | "implements"
  // behavioral / data
  | "calls"
  | "reads_from"
  | "writes_to"
  | "routes"
  | "serves"
  // dependency
  | "depends_on"
  | "tested_by"
  | "configures"
  // semantic
  | "related"
  | "similar_to"
  // domain
  | "contains_flow"
  | "flow_step"
  | "cross_domain";

/** Coarse complexity bucket shown as a badge on a node. */
export type AtlasComplexity = "simple" | "moderate" | "complex";

/** How a file participates in the project (drives layer heuristics + colours). */
export type AtlasFileCategory =
  | "code"
  | "config"
  | "docs"
  | "infra"
  | "data"
  | "script"
  | "markup";

/** A single node in the Atlas graph. */
export interface AtlasNode {
  /** Stable id, e.g. `file:src/x.ts`, `function:src/x.ts:foo`, `class:src/x.ts:Bar`. */
  id: string;
  type: AtlasNodeType;
  /** Basename or symbol name. */
  name: string;
  /** Workspace-relative path (every code/artifact node has one). */
  filePath?: string;
  /** 1-indexed `[startLine, endLine]` for symbol nodes. */
  lineRange?: [number, number];
  /** 1–3 sentence plain-English description (filled by LLM enrichment). */
  summary?: string;
  /** Free-form labels, e.g. `["entry-point", "async"]`. */
  tags?: string[];
  complexity?: AtlasComplexity;
  /** Detected language id for file nodes, e.g. `"typescript"`. */
  language?: string;
  /** File classification for file nodes. */
  category?: AtlasFileCategory;
}

/** A directed relationship between two nodes. */
export interface AtlasEdge {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  type: AtlasEdgeType;
  /** Strength 0–1; deterministic edges default to 1. */
  weight?: number;
  /** Optional human context for the relationship. */
  description?: string;
}

/** An architectural grouping of file-level nodes (e.g. "API Layer"). */
export interface AtlasLayer {
  /** Stable id, e.g. `layer:api`. */
  id: string;
  name: string;
  description?: string;
  /** Node ids that belong to this layer. */
  nodeIds: string[];
}

/** One step of the guided tour through the codebase. */
export interface AtlasTourStep {
  /** 1-based sequence number. */
  order: number;
  title: string;
  description: string;
  /** Nodes to highlight/inspect for this step. */
  nodeIds: string[];
}

/** Project-level metadata captured at analysis time. */
export interface AtlasProjectMeta {
  name: string;
  languages: string[];
  frameworks?: string[];
  description?: string;
  /** ISO-8601 timestamp the graph was built. */
  analyzedAt: string;
  /** HEAD commit the graph reflects, when in a git repo. */
  gitCommitHash?: string;
  /** Total files scanned (after ignore filtering). */
  totalFiles?: number;
}

/** The complete Atlas knowledge graph — the on-disk artifact. */
export interface AtlasGraph {
  /** {@link ATLAS_SCHEMA_VERSION} for current graphs. */
  schemaVersion: number;
  /** What the graph describes; defaults to `codebase`. */
  kind?: "codebase" | "knowledge";
  project: AtlasProjectMeta;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  layers: AtlasLayer[];
  tour: AtlasTourStep[];
}

const ATLAS_NODE_TYPES: readonly AtlasNodeType[] = [
  "file", "function", "class", "module",
  "config", "document", "service", "endpoint", "schema", "resource", "pipeline",
  "domain", "flow", "step",
];

const ATLAS_EDGE_TYPES: readonly AtlasEdgeType[] = [
  "contains", "imports", "exports", "inherits", "implements",
  "calls", "reads_from", "writes_to", "routes", "serves",
  "depends_on", "tested_by", "configures",
  "related", "similar_to",
  "contains_flow", "flow_step", "cross_domain",
];

const ATLAS_COMPLEXITIES: readonly AtlasComplexity[] = ["simple", "moderate", "complex"];

/** Narrow an unknown value to an {@link AtlasNodeType}. */
export function isAtlasNodeType(x: unknown): x is AtlasNodeType {
  return typeof x === "string" && (ATLAS_NODE_TYPES as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link AtlasEdgeType}. */
export function isAtlasEdgeType(x: unknown): x is AtlasEdgeType {
  return typeof x === "string" && (ATLAS_EDGE_TYPES as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link AtlasComplexity}. */
export function isAtlasComplexity(x: unknown): x is AtlasComplexity {
  return typeof x === "string" && (ATLAS_COMPLEXITIES as readonly string[]).includes(x);
}

/** All node types, for UI legends/filters. */
export function atlasNodeTypes(): AtlasNodeType[] {
  return [...ATLAS_NODE_TYPES];
}

/** Canonical node id for a file. */
export function atlasFileId(filePath: string): string {
  return `file:${filePath}`;
}

/**
 * Canonical node id for a symbol (function/class/etc.) defined in a file:
 * `<type>:<filePath>:<name>`.
 */
export function atlasSymbolId(type: AtlasNodeType, filePath: string, name: string): string {
  return `${type}:${filePath}:${name}`;
}

/** Structural type guard for an {@link AtlasNode}. */
export function isAtlasNode(x: unknown): x is AtlasNode {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    isAtlasNodeType(n.type) &&
    typeof n.name === "string" &&
    (n.filePath === undefined || typeof n.filePath === "string") &&
    (n.lineRange === undefined ||
      (Array.isArray(n.lineRange) && n.lineRange.length === 2 && n.lineRange.every((v) => typeof v === "number"))) &&
    (n.summary === undefined || typeof n.summary === "string") &&
    (n.tags === undefined || (Array.isArray(n.tags) && n.tags.every((t) => typeof t === "string"))) &&
    (n.complexity === undefined || isAtlasComplexity(n.complexity)) &&
    (n.language === undefined || typeof n.language === "string") &&
    (n.category === undefined || typeof n.category === "string")
  );
}

/** Structural type guard for an {@link AtlasEdge}. */
export function isAtlasEdge(x: unknown): x is AtlasEdge {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.source === "string" &&
    typeof e.target === "string" &&
    isAtlasEdgeType(e.type) &&
    (e.weight === undefined || typeof e.weight === "number") &&
    (e.description === undefined || typeof e.description === "string")
  );
}

/** Structural type guard for an {@link AtlasGraph}. */
export function isAtlasGraph(x: unknown): x is AtlasGraph {
  if (!x || typeof x !== "object") return false;
  const g = x as Record<string, unknown>;
  return (
    typeof g.schemaVersion === "number" &&
    (g.kind === undefined || g.kind === "codebase" || g.kind === "knowledge") &&
    !!g.project &&
    typeof g.project === "object" &&
    Array.isArray(g.nodes) &&
    g.nodes.every(isAtlasNode) &&
    Array.isArray(g.edges) &&
    g.edges.every(isAtlasEdge) &&
    Array.isArray(g.layers) &&
    Array.isArray(g.tour)
  );
}

/** An empty, well-formed graph for a project — the builder's starting point. */
export function emptyAtlasGraph(project: AtlasProjectMeta): AtlasGraph {
  return { schemaVersion: ATLAS_SCHEMA_VERSION, kind: "codebase", project, nodes: [], edges: [], layers: [], tour: [] };
}
