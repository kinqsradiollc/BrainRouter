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
  AtlasLayerEdge,
  AtlasNode,
  AtlasNodeType,
  AtlasTourStep,
} from "./atlas.js";
import { isAtlasComplexity } from "./atlas.js";
import { extractAtlasJsonArray } from "./atlas-json.js";

/** Inject the actual model call. Returns the assistant's raw text. */
/**
 * Inject the actual model call. Returns the assistant's raw text — OR, when
 * `tool` is supplied, the JSON `arguments` of a forced function call so the
 * output shape is fixed by the schema rather than a "return ONLY JSON" prompt
 * (consistent across model versions). The adapter should force `tool_choice` to
 * the tool and return its `arguments`; the prompt still carries the JSON
 * instruction as the fallback for tool-less backends. Either way the result is
 * parsed by `extractAtlasJsonArray`, which unwraps the `{wrapper:[…]}` a
 * function call must use.
 */
export type AtlasLlmCaller = (req: {
  system: string;
  user: string;
  signal?: AbortSignal;
  tool?: { name: string; description?: string; parameters: Record<string, unknown> };
}) => Promise<string>;

/**
 * A loose "emit an array" tool for the enrichment passes: it forces the model to
 * return its result as a function call wrapping the array in `prop` (function
 * parameters must be an object), WITHOUT constraining each item's fields — the
 * prompt still defines those. `extractAtlasJsonArray` unwraps the single-array
 * property on the way back.
 */
function arrayTool(
  name: string,
  prop: string,
  description: string,
  itemSchema: Record<string, unknown>,
): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        // A DESCRIPTIVE item schema (real fields), not a bare object: under a
        // FORCED tool call many models fill the schema rather than the prose, so
        // an empty `{type:"object"}` made them emit field-less objects (→ zero
        // usable rows). The fields mirror what the prompt asks for.
        [prop]: { type: "array", description: `${description} Return [] only if there is genuinely nothing.`, items: itemSchema },
      },
      required: [prop],
      additionalProperties: false,
    },
  };
}

/** A JSON-schema string field with a description (keeps the per-pass schemas terse). */
function str(description: string): Record<string, unknown> {
  return { type: "string", description };
}

/**
 * Run one array-producing enrichment call: prefer the FORCED tool call (schema-
 * shaped, consistent across models), but if it yields nothing — e.g. a backend
 * that ignores `tool_choice` or returns an empty tool call — fall back ONCE to a
 * plain prompt completion (the prompt already asks for the JSON). Either way the
 * result goes through the robust `extractAtlasJsonArray`. Never throws.
 */
async function callArray(
  llm: AtlasLlmCaller,
  user: string,
  signal: AbortSignal | undefined,
  tool: { name: string; description: string; parameters: Record<string, unknown> },
): Promise<unknown[]> {
  let rows: unknown[] = [];
  try {
    rows = extractAtlasJsonArray(await llm({ system: SYSTEM, user, signal, tool }));
  } catch {
    rows = [];
  }
  if (rows.length) return rows;
  try {
    return extractAtlasJsonArray(await llm({ system: SYSTEM, user, signal }));
  } catch {
    return [];
  }
}

export interface EnrichOptions {
  /** Cap how many file-level nodes are summarised (default 200). */
  maxFiles?: number;
  /** Files per summary LLM call (default 12). */
  batchSize?: number;
  /** Concurrent summary batches (default 3). */
  concurrency?: number;
  signal?: AbortSignal;
  /** Progress callback for a CLI spinner / desktop status. */
  onProgress?: (p: { phase: "summaries" | "layers" | "tour" | "relationships"; done: number; total: number }) => void;
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
  /** Semantic layer→layer relationship labels produced (Domain edges). */
  relationships: number;
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

/** Directed layer→layer import pairs (heaviest first), input to the relationship pass. */
function computeLayerImportPairs(graph: AtlasGraph, layers: AtlasLayer[], limit = 14): Array<{ source: string; target: string; weight: number }> {
  const layerOf = new Map<string, string>();
  for (const l of layers) for (const id of l.nodeIds) if (!layerOf.has(id)) layerOf.set(id, l.id);
  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const a = layerOf.get(e.source);
    const b = layerOf.get(e.target);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, weight]) => { const [source, target] = k.split(" "); return { source, target, weight }; })
    .sort((x, y) => y.weight - x.weight || x.source.localeCompare(y.source))
    .slice(0, limit);
}

function relationshipsPrompt(layers: AtlasLayer[], pairs: Array<{ source: string; target: string; weight: number }>): string {
  const nameById = new Map(layers.map((l) => [l.id, l.name] as const));
  const lines = pairs.map((p) => `- ${nameById.get(p.source)} -> ${nameById.get(p.target)} (${p.weight} imports)`);
  return [
    "For each directed dependency between architectural layers below, give a SHORT relationship verb phrase (2-4 words, lowercase) describing how the SOURCE uses the TARGET — e.g. \"calls\", \"reads from\", \"renders\", \"persists to\", \"validates with\", \"routes to\".",
    "",
    "Dependencies (source -> target):",
    ...lines,
    "",
    "Return ONLY a JSON array, one per dependency, exactly:",
    '[{"source":"<source layer name>","target":"<target layer name>","label":"<verb phrase>"}]',
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
    const rows = await callArray(
      llm,
      summaryPrompt(graph, batch, symbols),
      signal,
      arrayTool("emit_file_summaries", "summaries", "One summary object per file.", {
        type: "object",
        properties: {
          path: str("The file's EXACT path, copied from the list."),
          summary: str("One sentence describing the file's responsibility."),
          tags: { type: "array", items: { type: "string" }, description: "2-4 short lowercase tags." },
          complexity: { type: "string", enum: ["simple", "moderate", "complex"] },
        },
        required: ["path", "summary"],
      }),
    ) as SummaryRow[];
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
      const rows = await callArray(
        llm,
        layersPrompt(enriched, summarizedFileNodes),
        signal,
        arrayTool("emit_layers", "layers", "3-8 architectural layers grouping the files.", {
          type: "object",
          properties: {
            name: str("Short layer name, e.g. \"API\", \"Domain\", \"Data\", \"UI\"."),
            description: str("One sentence describing the layer."),
            files: { type: "array", items: { type: "string" }, description: "EXACT file paths belonging to this layer." },
          },
          required: ["name", "files"],
        }),
      ) as Array<{ name?: string; description?: string; files?: string[] }>;
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
  // Keep the deterministic (build-time) layers if the LLM produced none — never
  // regress to "no layers" just because enrichment was flaky.
  const effectiveLayers = layers.length ? layers : graph.layers;
  enriched.layers = effectiveLayers;

  // --- 3. guided tour (single call over the layers) ---
  let tour: AtlasTourStep[] = [];
  if (effectiveLayers.length) {
    onProgress?.({ phase: "tour", done: 0, total: 1 });
    try {
      const rows = await callArray(
        llm,
        tourPrompt(enriched, effectiveLayers),
        signal,
        arrayTool("emit_tour", "steps", "4-8 ordered onboarding-tour steps.", {
          type: "object",
          properties: {
            title: str("Short step title."),
            description: str("What to look at and why."),
            files: { type: "array", items: { type: "string" }, description: "EXACT file paths to read for this step." },
          },
          required: ["title"],
        }),
      ) as Array<{ title?: string; description?: string; files?: string[] }>;
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

  // --- 4. semantic layer relationships (Domain edge labels) ---
  let layerEdges: AtlasLayerEdge[] = [];
  const pairs = computeLayerImportPairs(enriched, effectiveLayers);
  if (pairs.length) {
    onProgress?.({ phase: "relationships", done: 0, total: 1 });
    try {
      const rows = await callArray(
        llm,
        relationshipsPrompt(effectiveLayers, pairs),
        signal,
        arrayTool("emit_layer_relationships", "relationships", "One labelled relationship per directed layer dependency.", {
          type: "object",
          properties: {
            source: str("Source layer name (exactly as listed)."),
            target: str("Target layer name (exactly as listed)."),
            label: str("Short verb phrase, e.g. \"calls\", \"reads from\", \"renders\"."),
          },
          required: ["source", "target", "label"],
        }),
      ) as Array<{ source?: string; target?: string; label?: string }>;
      const idByName = new Map(effectiveLayers.map((l) => [l.name, l.id] as const));
      const validPair = new Set(pairs.map((p) => `${p.source} ${p.target}`));
      const seen = new Set<string>();
      layerEdges = rows
        .map((r): AtlasLayerEdge | null => {
          if (!r || typeof r.source !== "string" || typeof r.target !== "string" || typeof r.label !== "string") return null;
          const source = idByName.get(r.source);
          const target = idByName.get(r.target);
          const label = r.label.trim();
          if (!source || !target || !label) return null;
          const key = `${source} ${target}`;
          // Only label real, deduped cross-layer dependencies the graph actually has.
          if (!validPair.has(key) || seen.has(key)) return null;
          seen.add(key);
          return { source, target, label: label.slice(0, 40) };
        })
        .filter((e): e is AtlasLayerEdge => e !== null);
    } catch {
      layerEdges = [];
    }
    onProgress?.({ phase: "relationships", done: 1, total: 1 });
  }
  if (layerEdges.length) enriched.layerEdges = layerEdges;

  return { graph: enriched, summarized, layers: effectiveLayers.length, tourSteps: tour.length, relationships: layerEdges.length, batchesFailed };
}
