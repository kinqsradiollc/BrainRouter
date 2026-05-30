/**
 * MEM-29 (0.4.4) — pure helpers for code-aware retrieval. Kept dependency-free
 * and side-effect-free so they're trivially unit-testable and reusable by the
 * engine's `find_related` path and (incrementally) the code-aware reranker.
 *
 * Three concerns live here:
 *   - turning a seed code chunk into a focused FTS query (symbol + salient
 *     identifiers, minus language boilerplate),
 *   - mapping a file path to the set of extensions in its language family so
 *     `find_related` can stay within one language, and
 *   - (MEM-27, below) path-prior penalties + per-file saturation so generated /
 *     test / barrel files don't crowd out real definitions.
 */
import type { SourceChunk, RelatedChunkHit } from "@kinqs/brainrouter-types";

/**
 * Identifiers that are pure language boilerplate — indexing them as query terms
 * just matches every file. Deliberately small + cross-language (TS/JS/Python/Go
 * /Rust overlap) rather than an exhaustive per-language keyword table.
 */
const BOILERPLATE = new Set<string>([
  "const", "let", "var", "function", "return", "import", "export", "from", "default",
  "this", "self", "true", "false", "null", "none", "undefined", "void", "async", "await",
  "type", "interface", "class", "enum", "struct", "impl", "trait", "public", "private",
  "protected", "static", "readonly", "extends", "implements", "new", "delete", "typeof",
  "instanceof", "if", "else", "elif", "for", "while", "switch", "case", "break", "continue",
  "try", "catch", "finally", "throw", "raise", "with", "as", "in", "of", "is", "and", "or",
  "not", "def", "lambda", "pass", "yield", "fn", "let", "mut", "pub", "use", "mod", "match",
  "string", "number", "boolean", "object", "array", "list", "dict", "map", "set", "int",
  "float", "bool", "str", "char", "byte", "value", "data", "item", "items", "args", "kwargs",
  "props", "params", "options", "opts", "result", "results", "config", "context", "ctx",
]);

/** Split a compound identifier (camelCase / snake_case / dotted / kebab) into parts. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/[._\-/$]+/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !BOILERPLATE.has(s.toLowerCase()));
}

/**
 * Build a focused, deduped bag of query terms for a seed chunk: the symbol (and
 * its sub-parts) first, then the most frequent salient identifiers from the
 * body. Capped so the resulting FTS OR-query stays selective rather than
 * matching half the corpus. Returns a space-joined string for `buildFtsQuery`.
 */
export function extractChunkQueryTerms(
  input: { symbol?: string | null; content?: string | null },
  opts?: { maxTerms?: number },
): string {
  const maxTerms = Math.max(4, opts?.maxTerms ?? 16);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim();
    if (t.length < 3) return;
    const key = t.toLowerCase();
    if (BOILERPLATE.has(key) || seen.has(key)) return;
    seen.add(key);
    ordered.push(t);
  };

  // Symbol first — it's the strongest "what is this chunk about" signal.
  if (input.symbol) {
    push(input.symbol);
    for (const part of splitIdentifier(input.symbol)) push(part);
  }

  // Frequency-rank identifiers from the body, then merge in by descending count.
  const counts = new Map<string, number>();
  const ids = (input.content ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const id of ids) {
    if (id.length < 3) continue;
    const key = id.toLowerCase();
    if (BOILERPLATE.has(key)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const byFreq = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [id] of byFreq) {
    if (ordered.length >= maxTerms) break;
    push(id);
  }

  return ordered.slice(0, maxTerms).join(" ");
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * MEM-29 baseline ranking for `find_related` hits. The store hands back chunks
 * already ordered by FTS5 bm25 `ftsRank` (≤ 0, more negative = stronger). We map
 * that magnitude to a 0..1 base relevance.
 *
 * This is the single seam the code-aware reranker grows into: MEM-27 multiplies
 * a path-prior penalty + applies per-file saturation here, and MEM-26 adds
 * definition / symbol-match / file-coherence boosts. Keeping the math in one
 * pure function keeps the engine method thin and the scoring unit-testable.
 */
export function rankRelatedChunks(
  seed: { symbol?: string | null; filePath?: string | null },
  hits: Array<SourceChunk & { ftsRank: number }>,
  limit: number,
): RelatedChunkHit[] {
  if (hits.length === 0) return [];
  const cap = Math.max(1, limit);
  const bases = hits.map((h) => -(h.ftsRank ?? 0));
  const max = Math.max(...bases, 1e-6);

  const scored = hits.map((h, i) => {
    const { ftsRank: _omit, ...chunk } = h;
    const reasons: string[] = ["lexical"];
    const base = clamp01(bases[i] / max);
    // ── MEM-27 extension point: path-prior penalty ──
    // ── MEM-26 extension point: definition / symbol-match / coherence boosts ──
    const score = clamp01(base);
    return { chunk: chunk as SourceChunk, score, reason: reasons.join("+") };
  });

  scored.sort((a, b) => b.score - a.score);
  // ── MEM-27 extension point: per-file saturation cap (applied post-sort) ──
  return scored.slice(0, cap);
}

/** Language families keyed by extension — used to scope find_related to one language. */
const LANGUAGE_FAMILIES: string[][] = [
  [".ts", ".tsx", ".mts", ".cts"],
  [".js", ".jsx", ".mjs", ".cjs"],
  [".py", ".pyi"],
  [".go"],
  [".rs"],
  [".java", ".kt", ".kts"],
  [".c", ".h"],
  [".cc", ".cpp", ".cxx", ".hpp", ".hh"],
  [".rb"],
  [".php"],
  [".cs"],
  [".swift"],
  [".md", ".mdx", ".markdown"],
];

/** Lowercased file extension including the dot, or "" when there is none. */
export function fileExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * The set of extensions in the same language family as `filePath` (so a `.ts`
 * seed also matches `.tsx`). Returns the bare extension when it's unknown, or
 * `[]` when the path has no extension (caller then skips language scoping).
 */
export function languageScopeFor(filePath: string | null | undefined): string[] {
  if (!filePath) return [];
  const ext = fileExtension(filePath);
  if (!ext) return [];
  const fam = LANGUAGE_FAMILIES.find((f) => f.includes(ext));
  return fam ?? [ext];
}
