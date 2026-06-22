/**
 * Atlas LLM enrichment (ATLAS-4).
 *
 * Takes a deterministic base graph (from buildBaseGraph) and layers on the
 * understanding a human reviewer would add: a one-line summary + tags +
 * complexity for each file, architectural LAYERS grouping the files, and an
 * ordered guided TOUR that walks the codebase in a sensible reading order.
 *
 * The LLM is injected as a plain async function ({@link AtlasLlmCaller}) so this
 * module stays free of any model-client dependency and is fully unit-testable
 * with a stub. The CLI / desktop adapt their existing `callOpenAI` to it. Every
 * LLM response is parsed through the robust extractor in `jsonExtract.ts`; a
 * batch whose output can't be parsed is skipped, never fatal — enrichment is
 * always best-effort on top of the (already useful) base graph.
 */
import type {
  AtlasComplexity,
  AtlasGraph,
  AtlasLayer,
  AtlasNode,
  AtlasNodeType,
  AtlasTourStep,
} from "@kinqs/brainrouter-types";
import { isAtlasComplexity } from "@kinqs/brainrouter-types";
import { extractAtlasJsonArray } from "./jsonExtract.js";

/** Inject the actual model call. Returns the assistant's raw text. */
export type AtlasLlmCaller = (req: { system: string; user: string; signal?: AbortSignal }) => Promise<string>;

export interface EnrichOptions {
  /** Cap how many file-level nodes are summarised (default 200). */
  maxFiles?: number;
  /** Files per summary LLM call (default 12). */
  batchSize?: number;
  /** Concurrent summary batches (default 3). */
  concurrency?: number;
  signal?: AbortSignal;
  /** Progress callback for a CLI spinner / desktop status. */
  onProgress?: (p: { phase: "summaries" | "layers" | "tour"; done: number; total: number }) => void;
}

export interface EnrichResult {
  /** The enriched graph (new object; input is not mutated). */
  graph: AtlasGraph;
  /** Files that received a summary. */
  summarized: number;
  /** Layers produced. */
  layers: number;
  /** Tour steps produced. */
  tourSteps: number;
  /** Summary batches whose LLM output could not be parsed (skipped). */
  batchesFailed: number;
}

/** File-level node types worth summarising (symbols are detail, skipped here). */
const FILE_LEVEL: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

const SYSTEM = "You are a precise code cartographer. You map codebases for engineers who are new to them. Answer ONLY with the JSON the user asks for — no prose, no code fences.";

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "layer";
}

/** Symbol names defined in each file, via `contains` edges → function/class nodes. */
function symbolsByFile(graph: AtlasGraph): Map<string, string[]> {
  const nameById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "contains") continue;
    const child = nameById.get(e.target);
    const parent = nameById.get(e.source);
    if (!child || !parent?.filePath) continue;
    if (child.type !== "function" && child.type !== "class") continue;
    const list = out.get(parent.filePath) ?? [];
    if (list.length < 12) list.push(child.name);
    out.set(parent.filePath, list);
  }
  return out;
}

interface SummaryRow {
  path: string;
  summary?: string;
  tags?: string[];
  complexity?: AtlasComplexity;
}

function summaryPrompt(graph: AtlasGraph, batch: AtlasNode[], symbols: Map<string, string[]>): string {
  const lang = graph.project.languages.join(", ") || "unknown";
  const lines = batch.map((n, i) => {
    const syms = symbols.get(n.filePath ?? "")?.slice(0, 8).join(", ");
    return `${i + 1}. ${n.filePath} [${n.language ?? n.type}]${syms ? ` — symbols: ${syms}` : ""}`;
  });
  return [
    `Project "${graph.project.name}" (${lang}). For EACH file below, give its responsibility in ONE sentence, 2-4 short lowercase tags, and a complexity of "simple", "moderate", or "complex". Use only the information given; do not invent files.`,
    "",
    "Files:",
    ...lines,
    "",
    'Return ONLY a JSON array, one object per file, exactly:',
    '[{"path":"<exact path above>","summary":"...","tags":["..."],"complexity":"simple|moderate|complex"}]',
  ].join("\n");
}

function layersPrompt(graph: AtlasGraph, files: AtlasNode[]): string {
  const lines = files.map((n) => `- ${n.filePath}: ${n.summary ?? n.name}`);
  return [
    `Group these files from "${graph.project.name}" into 3-8 architectural layers (e.g. "Entry", "API", "Domain", "Data", "UI", "Config", "Docs"). Every file should belong to exactly one layer; omit a file only if it truly fits none.`,
    "",
    "Files:",
    ...lines,
    "",
    'Return ONLY a JSON array, exactly:',
    '[{"name":"...","description":"one sentence","files":["<exact path>", "..."]}]',
  ].join("\n");
}

function tourPrompt(graph: AtlasGraph, layers: AtlasLayer[]): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const lines = layers.map((l) => `- ${l.name}: ${l.nodeIds.map((id) => byId.get(id)?.filePath).filter(Boolean).slice(0, 8).join(", ")}`);
  return [
    `Design an ordered onboarding tour (4-8 steps) that walks a new engineer through "${graph.project.name}" in a sensible reading order — start at the entry point, end at the leaves. Each step names a few files to read and why.`,
    "",
    "Layers:",
    ...lines,
    "",
    'Return ONLY a JSON array, in order, exactly:',
    '[{"title":"...","description":"what to look at and why","files":["<exact path>", "..."]}]',
  ].join("\n");
}

/**
 * Enrich a base graph in place-safe fashion (returns a new graph; the input is
 * left untouched). Best-effort: any LLM/parse failure degrades to fewer
 * summaries / no layers / no tour rather than throwing.
 */
export async function enrichAtlasGraph(graph: AtlasGraph, llm: AtlasLlmCaller, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const maxFiles = opts.maxFiles ?? 200;
  const batchSize = opts.batchSize ?? 12;
  const concurrency = opts.concurrency ?? 3;
  const { signal, onProgress } = opts;

  const fileNodes = graph.nodes.filter((n) => FILE_LEVEL.has(n.type) && n.filePath);
  const targets = fileNodes.slice(0, maxFiles);
  const symbols = symbolsByFile(graph);

  // --- 1. per-file summaries (batched, concurrent) ---
  const batches = chunk(targets, batchSize);
  const summaries = new Map<string, SummaryRow>();
  let done = 0;
  let batchesFailed = 0;
  onProgress?.({ phase: "summaries", done: 0, total: batches.length });

  const batchResults = await mapPool(batches, concurrency, async (batch) => {
    let rows: SummaryRow[];
    try {
      const raw = await llm({ system: SYSTEM, user: summaryPrompt(graph, batch, symbols), signal });
      rows = extractAtlasJsonArray(raw) as SummaryRow[];
    } catch {
      rows = [];
    }
    done++;
    onProgress?.({ phase: "summaries", done, total: batches.length });
    if (!rows.length) { batchesFailed++; return; }
    for (const r of rows) {
      if (r && typeof r.path === "string") summaries.set(r.path, r);
    }
  });
  void batchResults;

  // Merge summaries onto cloned nodes (input graph stays untouched).
  let summarized = 0;
  const nodes: AtlasNode[] = graph.nodes.map((n) => {
    // Only file-level nodes get summaries; a symbol node shares its file's path
    // but must not inherit the file's summary.
    const row = n.filePath && FILE_LEVEL.has(n.type) ? summaries.get(n.filePath) : undefined;
    if (!row) return n;
    const tags = Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === "string").slice(0, 6) : undefined;
    const complexity = isAtlasComplexity(row.complexity) ? row.complexity : n.complexity;
    const summary = typeof row.summary === "string" && row.summary.trim() ? row.summary.trim() : undefined;
    if (summary) summarized++;
    return { ...n, summary: summary ?? n.summary, tags: tags ?? n.tags, complexity };
  });

  const enriched: AtlasGraph = { ...graph, nodes };
  const summarizedFileNodes = nodes.filter((n) => FILE_LEVEL.has(n.type) && n.filePath && n.summary);

  // --- 2. architectural layers (single call over the summarised files) ---
  // Resolve LLM-named file paths to actual node ids — a path may belong to a
  // config/document/etc. node (id `config:…`), not necessarily `file:…`.
  const idByPath = new Map(nodes.filter((n) => n.filePath && FILE_LEVEL.has(n.type)).map((n) => [n.filePath as string, n.id] as const));
  let layers: AtlasLayer[] = [];
  if (summarizedFileNodes.length) {
    onProgress?.({ phase: "layers", done: 0, total: 1 });
    try {
      const raw = await llm({ system: SYSTEM, user: layersPrompt(enriched, summarizedFileNodes), signal });
      const rows = extractAtlasJsonArray(raw) as Array<{ name?: string; description?: string; files?: string[] }>;
      const seen = new Set<string>();
      layers = rows
        .filter((r) => r && typeof r.name === "string" && Array.isArray(r.files))
        .map((r) => {
          let id = `layer:${slugify(r.name as string)}`;
          while (seen.has(id)) id += "-x";
          seen.add(id);
          const nodeIds = (r.files as string[])
            .map((f) => idByPath.get(f))
            .filter((id): id is string => typeof id === "string");
          return { id, name: r.name as string, description: r.description, nodeIds } as AtlasLayer;
        })
        .filter((l) => l.nodeIds.length > 0);
    } catch {
      layers = [];
    }
    onProgress?.({ phase: "layers", done: 1, total: 1 });
  }
  enriched.layers = layers;

  // --- 3. guided tour (single call over the layers) ---
  let tour: AtlasTourStep[] = [];
  if (layers.length) {
    onProgress?.({ phase: "tour", done: 0, total: 1 });
    try {
      const raw = await llm({ system: SYSTEM, user: tourPrompt(enriched, layers), signal });
      const rows = extractAtlasJsonArray(raw) as Array<{ title?: string; description?: string; files?: string[] }>;
      tour = rows
        .filter((r) => r && typeof r.title === "string")
        .map((r, i) => ({
          order: i + 1,
          title: r.title as string,
          description: typeof r.description === "string" ? r.description : "",
          nodeIds: (Array.isArray(r.files) ? r.files : [])
            .map((f) => idByPath.get(f))
            .filter((id): id is string => typeof id === "string"),
        }));
    } catch {
      tour = [];
    }
    onProgress?.({ phase: "tour", done: 1, total: 1 });
  }
  enriched.tour = tour;

  return { graph: enriched, summarized, layers: layers.length, tourSteps: tour.length, batchesFailed };
}
