/**
 * ADR-048 — Atlas as agent-visible context: the pure builders.
 *
 * Two bounded, deterministic projections of the workspace Atlas graph for the
 * turn loop and the `atlas_context` tool:
 *
 *  - {@link atlasOrientation} — a once-per-session "what is this repo" block:
 *    project, layers with sizes, the tour's first stops, and an honest staleness
 *    note when HEAD has moved since the graph was built.
 *  - {@link atlasPromptRetrieval} — the nodes a prompt's terms actually match
 *    (names, paths, tags, summaries), coverage-gated so weak matches render
 *    nothing at all.
 *
 * Both are pure over the graph (no I/O, no LLM) and bounded in code (D2): a
 * missing/empty graph or a gated match returns "" and the caller injects
 * nothing. Injected text is DATA for the model — summaries pass through the same
 * untrusted-content posture as any workspace text (D3); nothing here can carry a
 * directive anywhere authority lives.
 */
import type { AtlasGraph, AtlasNode } from "@kinqs/brainrouter-types";

/** Prompts shorter than this never trigger retrieval — they are conversational. */
export const ATLAS_RETRIEVAL_MIN_PROMPT_CHARS = 12;
const ORIENTATION_MAX_CHARS = 1_500;
const RETRIEVAL_MAX_CHARS = 2_000;
const RETRIEVAL_TOP_K = 6;
const SUMMARY_CLIP = 140;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was",
  "can", "you", "how", "what", "where", "why", "when", "does", "not", "all",
  "add", "fix", "make", "use", "using", "please", "then", "them", "its", "our",
  "file", "files", "code",
]);

function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Prompt → lowercase content terms (≥3 chars, stopwords dropped, deduped). */
export function atlasPromptTerms(prompt: string): string[] {
  const seen = new Set<string>();
  for (const raw of String(prompt ?? "").toLowerCase().split(/[^a-z0-9_$./-]+/)) {
    // Split path-ish tokens further so "src/memory/recall.ts" also yields parts.
    for (const part of raw.split(/[./]/)) {
      if (part.length >= 3 && !STOPWORDS.has(part)) seen.add(part);
    }
    if (raw.length >= 3 && !STOPWORDS.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/** nodeId → owning layer name, for rendering. */
function layerByNode(graph: AtlasGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const layer of graph.layers ?? []) {
    for (const id of layer.nodeIds) if (!map.has(id)) map.set(id, layer.name);
  }
  return map;
}

/**
 * The once-per-session orientation block, or "" when the graph is absent/empty.
 * `currentHeadSha` (when known) makes drift honest: a map built at another
 * commit says so instead of presenting itself as current.
 */
export function atlasOrientation(
  graph: AtlasGraph | null | undefined,
  opts: { currentHeadSha?: string } = {},
): string {
  if (!graph || graph.nodes.length === 0) return "";
  const project = graph.project;
  const files = project.totalFiles
    ?? graph.nodes.filter((n) => n.type !== "function" && n.type !== "class").length;
  const lines: string[] = [];
  lines.push(
    `[codebase map] ${project.name} — ${project.languages.join(", ") || "unknown languages"}, ${files} files mapped.`,
  );
  const built = graph.project.gitCommitHash;
  if (built && opts.currentHeadSha && !opts.currentHeadSha.startsWith(built) && !built.startsWith(opts.currentHeadSha)) {
    lines.push(
      `Note: map built at ${shortSha(built)}; HEAD is now ${shortSha(opts.currentHeadSha)} — details may be stale.`,
    );
  }
  const layers = [...(graph.layers ?? [])]
    .sort((a, b) => b.nodeIds.length - a.nodeIds.length)
    .slice(0, 6);
  if (layers.length) {
    lines.push(`Layers: ${layers.map((l) => `${l.name} (${l.nodeIds.length})`).join(", ")}.`);
  }
  const tour = [...(graph.tour ?? [])].sort((a, b) => a.order - b.order).slice(0, 3);
  for (const step of tour) {
    lines.push(`- ${step.title}: ${clip(step.description, SUMMARY_CLIP)}`);
  }
  lines.push("Use the atlas_context tool to query this map by term.");
  return clip(lines.join("\n"), ORIENTATION_MAX_CHARS);
}

interface ScoredNode {
  node: AtlasNode;
  score: number;
  strong: boolean;
}

function scoreNode(node: AtlasNode, terms: string[]): ScoredNode {
  const name = node.name.toLowerCase();
  const path = (node.filePath ?? "").toLowerCase();
  const tags = (node.tags ?? []).map((t) => t.toLowerCase());
  const summary = (node.summary ?? "").toLowerCase();
  let score = 0;
  let strong = false;
  let summaryHits = 0;
  for (const term of terms) {
    if (name === term) { score += 5; strong = true; continue; }
    if (name.includes(term) || term.includes(name)) { score += 3; strong = true; continue; }
    if (path.split(/[/.]/).includes(term)) { score += 2; strong = true; continue; }
    if (tags.includes(term)) { score += 2; strong = true; continue; }
    if (summaryHits < 3 && summary.includes(term)) { score += 1; summaryHits++; }
  }
  return { node, score, strong };
}

/**
 * The retrieval block for a prompt, or "" when the coverage gate holds it back
 * (short prompt, no strong match, or a total score too weak to trust). Strong =
 * a term hit a node's NAME, PATH segment, or TAG — summary-only matches never
 * pass the gate alone.
 */
export function atlasPromptRetrieval(
  graph: AtlasGraph | null | undefined,
  prompt: string,
  opts: { topK?: number; minPromptChars?: number } = {},
): string {
  if (!graph || graph.nodes.length === 0) return "";
  // The floor guards AUTOMATIC injection against conversational prompts; the
  // atlas_context tool passes 1 — an explicit query is deliberate at any length.
  const minChars = opts.minPromptChars ?? ATLAS_RETRIEVAL_MIN_PROMPT_CHARS;
  if (String(prompt ?? "").trim().length < minChars) return "";
  const terms = atlasPromptTerms(prompt);
  if (terms.length === 0) return "";

  const scored = graph.nodes
    .map((node) => scoreNode(node, terms))
    .filter((s) => s.score > 0);
  const anyStrong = scored.some((s) => s.strong);
  const total = scored.reduce((n, s) => n + s.score, 0);
  if (!anyStrong || total < 4) return "";

  const layers = layerByNode(graph);
  const top = scored
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
    .slice(0, opts.topK ?? RETRIEVAL_TOP_K);

  const lines = [`[codebase map] Matches for this prompt:`];
  for (const { node } of top) {
    const where = node.filePath ?? node.name;
    const layer = layers.get(node.id);
    const summary = node.summary ? ` — ${clip(node.summary, SUMMARY_CLIP)}` : "";
    lines.push(`- ${where}${layer ? ` (${layer})` : ""}${summary}`);
  }
  return clip(lines.join("\n"), RETRIEVAL_MAX_CHARS);
}
