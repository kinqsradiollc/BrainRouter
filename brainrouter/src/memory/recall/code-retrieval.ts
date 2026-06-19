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
 * MEM-28b (0.4.4) — extract module specifiers from a file's import statements
 * (JS/TS `import … from 'x'` / `require('x')` / `import('x')` / bare `import 'x'`,
 * Python `from x import …`). Used to build cross-file import edges: find_related
 * resolves the RELATIVE specifiers to indexed documents and surfaces them.
 * Bare/package specifiers are returned too but won't resolve to local files.
 */
export function extractImportSpecifiers(content: string): string[] {
  const out = new Set<string>();
  const text = content ?? "";
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"\n]+)['"]/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/gm)) out.add(m[1]);
  return [...out].map((s) => s.trim()).filter((s) => s.length >= 2 && s.length < 200);
}

/**
 * MEM-28b — resolve a RELATIVE import specifier against the importing file's
 * path to an extensionless target path (e.g. `src/config.ts` + `./parser` →
 * `src/parser`). Returns null for bare/package specifiers (not local files).
 * Pure; the store then matches the target to an indexed document.
 */
export function resolveRelativeImport(seedFilePath: string, specifier: string): string | null {
  if (!seedFilePath || !specifier.startsWith(".")) return null;
  const dir = seedFilePath.slice(0, seedFilePath.lastIndexOf("/") + 1);
  const stack: string[] = [];
  for (const part of `${dir}${specifier}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  // Drop a known code extension if the specifier included one.
  let joined = stack.join("/");
  joined = joined.replace(/\.(t|j)sx?$/, "");
  return joined || null;
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i >= 0 ? filePath.slice(0, i) : "";
}

/**
 * MEM-26 — the set of identifiers a chunk *defines* (declaration-keyword
 * prefixed: function/class/def/const/type/fn/…). Lowercased. Used for the
 * definition-boost: a candidate that defines an identifier the seed references
 * (a callee / base class) is far more useful than one that merely mentions it.
 */
const DEFINITION_RE = /\b(?:function|func|fn|class|interface|type|enum|struct|trait|impl|def|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
export function definedIdentifiers(content: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!content) return out;
  DEFINITION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFINITION_RE.exec(content)) !== null) {
    if (m[1].length >= 2) out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * MEM-26 — the seed's referenced identifiers (symbol + its stems + salient body
 * identifiers), lowercased. This is what candidates are scored against for the
 * definition / symbol / stem boosts. Identifier-stem matching falls out for free
 * because `splitIdentifier` adds `parse`/`config` for a `parseConfig` symbol.
 */
export function deriveSeedIdentifiers(seed: { symbol?: string | null; content?: string | null }): Set<string> {
  const set = new Set<string>();
  if (seed.symbol) {
    set.add(seed.symbol.toLowerCase());
    for (const p of splitIdentifier(seed.symbol)) set.add(p.toLowerCase());
  }
  const ids = (seed.content ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (id.length >= 3 && !BOILERPLATE.has(key)) set.add(key);
  }
  return set;
}

/**
 * MEM-26 — code-aware boost for one candidate against the seed's identifiers.
 * Returns an additive boost (bounded) + reason tags. Signals:
 *   +def       candidate defines an identifier the seed references (strongest),
 *   +sym       candidate's symbol stems overlap the seed (weaker),
 *   +samefile  candidate is another chunk of the seed's own file (coherence),
 *   +samedir   candidate sits in the same directory.
 * Pure; the caller folds the boost in *before* the path penalty so a penalty
 * still dominates (a test that defines the symbol stays below real source).
 */
export function codeRerankBoost(
  seedIds: Set<string>,
  seedFilePath: string | null | undefined,
  candidate: { symbol?: string | null; content?: string | null; filePath?: string | null },
): { boost: number; reasons: string[] } {
  let boost = 0;
  const reasons: string[] = [];

  let defines = false;
  if (candidate.symbol && seedIds.has(candidate.symbol.toLowerCase())) defines = true;
  if (!defines) {
    for (const d of definedIdentifiers(candidate.content)) {
      if (seedIds.has(d)) { defines = true; break; }
    }
  }
  if (defines) { boost += 0.3; reasons.push("+def"); }

  if (candidate.symbol && !defines) {
    const parts = [candidate.symbol.toLowerCase(), ...splitIdentifier(candidate.symbol).map((s) => s.toLowerCase())];
    const overlap = parts.filter((p) => seedIds.has(p)).length;
    if (overlap > 0) { boost += Math.min(0.15, 0.06 * overlap); reasons.push("+sym"); }
  }

  if (seedFilePath && candidate.filePath) {
    if (candidate.filePath === seedFilePath) { boost += 0.12; reasons.push("+samefile"); }
    else if (dirOf(candidate.filePath) === dirOf(seedFilePath)) { boost += 0.06; reasons.push("+samedir"); }
  }

  return { boost: Math.min(0.5, boost), reasons };
}

/**
 * MEM-27 — path-prior penalty. A relevance multiplier in (0,1] that down-ranks
 * chunks from files you rarely want as the *definition* of a symbol: vendored
 * code, build output / generated files, `.d.ts` type stubs, tests, and barrels.
 * The strongest (lowest) applicable multiplier wins. `tag` names the reason for
 * the score breakdown. Pure + ordering-independent.
 *
 * Barrel detection is content-aware (a file that is almost entirely
 * `export … from …` re-exports) since an `index.*` filename alone is too blunt.
 */
export function pathPriorPenalty(
  filePath: string | null | undefined,
  content?: string | null,
): { multiplier: number; tag: string | null } {
  let multiplier = 1;
  let tag: string | null = null;
  const consider = (m: number, t: string) => {
    if (m < multiplier) { multiplier = m; tag = t; }
  };

  const fp = (filePath ?? "").toLowerCase();
  if (fp) {
    if (/(^|\/)(node_modules|vendor|third_party|bower_components)\//.test(fp)) consider(0.2, "vendor");
    if (/(^|\/)(dist|build|out|target|\.next|coverage)\//.test(fp)) consider(0.3, "build-output");
    if (/\.(min|bundle)\.[cm]?js$/.test(fp) || /\.(generated|gen|g)\.[a-z]+$/.test(fp) || /(^|\/)generated\//.test(fp) || /\.pb\.(go|ts|js)$|_pb2?\.py$/.test(fp)) consider(0.3, "generated");
    if (/\.d\.[cm]?ts$/.test(fp)) consider(0.4, "type-decl");
    if (/(\.|_)(test|spec)\.[a-z]+$/.test(fp) || /(^|\/)(__tests__|tests?|spec|__mocks__)\//.test(fp)) consider(0.5, "test");
  }

  // Barrel: an index.* whose body is dominated by re-export lines.
  if (content && /(^|\/)index\.[cm]?[jt]sx?$/.test(fp)) {
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const reexports = lines.filter((l) => /^export\s+(\*|\{[^}]*\})\s+from\s+/.test(l) || /^export\s+\{[^}]*\}\s*;?$/.test(l)).length;
      if (reexports / lines.length >= 0.6) consider(0.7, "barrel");
    }
  }

  return { multiplier, tag };
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
  seed: { symbol?: string | null; filePath?: string | null; content?: string | null },
  hits: Array<SourceChunk & { ftsRank: number }>,
  limit: number,
  opts?: { maxPerFile?: number },
): RelatedChunkHit[] {
  if (hits.length === 0) return [];
  const cap = Math.max(1, limit);
  const maxPerFile = Math.max(1, opts?.maxPerFile ?? 2);
  const bases = hits.map((h) => -(h.ftsRank ?? 0));
  const max = Math.max(...bases, 1e-6);
  const seedIds = deriveSeedIdentifiers(seed);

  const scored = hits.map((h, i) => {
    const { ftsRank: _omit, ...chunk } = h;
    const reasons: string[] = ["lexical"];
    const base = clamp01(bases[i] / max);
    // MEM-26 — code-aware boosts: definition / symbol-match / file-coherence.
    const { boost, reasons: boostReasons } = codeRerankBoost(seedIds, seed.filePath ?? null, chunk);
    reasons.push(...boostReasons);
    // MEM-27 — path-prior penalty: de-prioritize vendored/generated/test/barrel
    // chunks so a real definition outranks its test or its .d.ts stub. Applied
    // to the boosted score so a penalty stays dominant (a test that defines the
    // symbol still ranks below real source).
    const { multiplier, tag } = pathPriorPenalty(chunk.filePath, chunk.content);
    if (tag) reasons.push(`-${tag}`);
    // Weight the raw lexical base below 1 so the code-aware boosts (≤0.5) can
    // reorder comparably-matched hits — a definition should beat a mention of
    // similar lexical strength — without letting a single signal override a
    // hit that matched far more strongly.
    const score = clamp01((base * 0.7 + boost) * multiplier);
    return { chunk: chunk as SourceChunk, score, reason: reasons.join("+") };
  });

  scored.sort((a, b) => b.score - a.score);

  // MEM-27 — per-file saturation: keep at most `maxPerFile` chunks from any one
  // file in the result so a single large file can't crowd out the rest. Extras
  // spill into an overflow list, appended only if we'd otherwise return < cap.
  const perFile = new Map<string, number>();
  const kept: RelatedChunkHit[] = [];
  const overflow: RelatedChunkHit[] = [];
  for (const hit of scored) {
    const key = hit.chunk.filePath ?? `__doc:${hit.chunk.documentId}`;
    const n = perFile.get(key) ?? 0;
    if (n < maxPerFile) {
      perFile.set(key, n + 1);
      kept.push(hit);
    } else {
      overflow.push(hit);
    }
    if (kept.length >= cap) break;
  }
  if (kept.length < cap) kept.push(...overflow.slice(0, cap - kept.length));
  return kept.slice(0, cap);
}

/**
 * MEM-28 (0.4.4) — intra-file call/reference edges. Given all the chunks of one
 * document, return edges `from → to` where chunk `from`'s body references a
 * top-level symbol DEFINED by chunk `to` in the same file (a callee). The
 * reverse direction (callers) is just the same edges read backwards.
 *
 * Deliberately conservative + deterministic: exact symbol-name match only, no
 * scope analysis; an ambiguous symbol (defined by two chunks) is dropped rather
 * than guessed; self-edges excluded. Cross-file import edges + dynamic dispatch
 * are a Phase-2 follow-up (resolution is order-dependent across documents).
 */
export function extractIntraFileCallEdges(
  chunks: Array<{ id: string; symbol: string | null; content: string }>,
): Array<{ fromChunkId: string; toChunkId: string }> {
  const symbolToChunk = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const c of chunks) {
    if (!c.symbol) continue;
    if (symbolToChunk.has(c.symbol)) ambiguous.add(c.symbol);
    else symbolToChunk.set(c.symbol, c.id);
  }
  for (const a of ambiguous) symbolToChunk.delete(a); // ambiguous → skip, don't guess
  if (symbolToChunk.size === 0) return [];

  const edges: Array<{ fromChunkId: string; toChunkId: string }> = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const ids = new Set(c.content.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
    for (const id of ids) {
      const target = symbolToChunk.get(id);
      if (!target || target === c.id) continue;
      const key = `${c.id} ${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromChunkId: c.id, toChunkId: target });
    }
  }
  return edges;
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
