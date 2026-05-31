import type { SourceChunkInput } from "@kinqs/brainrouter-types";
import { createRequire } from "node:module";
import { chunkSource, estimateTokens, type ChunkOptions } from "./chunker.js";

/**
 * Brain Phase 2 (MEM-6) / MEM-18 (0.4.4) — structural code chunker.
 *
 * Splits source at definition boundaries (functions, classes, etc.) so each
 * chunk is a coherent unit of meaning — retrieval hits land on a whole symbol
 * and a definition's evidence stays together. Each chunk carries the symbol
 * name and 1-based line range.
 *
 * MEM-18 replaced the 0.4.3 regex first-cut (which only matched a symbol's
 * START line and ran each region "until the next symbol begins", bleeding
 * trailing blanks/comments/top-level code into the prior symbol) with a real
 * structural scan:
 *
 *   - C-family (TS/JS/Rust): a char-level brace scanner (`scanBracedEnd`) that
 *     ignores braces inside strings/line/block comments and finds the exact
 *     line where the body closes — or the terminating `;` for brace-less items.
 *   - Python: an indentation scanner (`scanIndentEnd`) that ends a top-level
 *     `def`/`class` at the dedent back to column 0.
 *
 * Boundaries are still recognised by lightweight per-language start patterns on
 * UNINDENTED lines (top-level symbols only; nested members stay inside their
 * parent's chunk). Top-level code BETWEEN symbols becomes its own unlabelled
 * region rather than being absorbed by the symbol above it. When no symbols are
 * recognised it falls back to the line-based `chunkSource`, and an oversized
 * symbol is sub-split the same way (parts keep the symbol name with a `#n`
 * suffix). The `CodeStructureAdapter` seam lets a tree-sitter/LSP adapter
 * replace the scanner later without changing the chunk contract.
 */

type Pattern = RegExp;

// TS/JS — top-level function / class / arrow-or-function const / interface /
// type-alias / enum. The const form requires the RHS to look like a function
// so plain data constants aren't treated as symbol boundaries.
const TS_JS: Pattern[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^;]*?\)\s*(?::[^=]+?)?=>|\([^;]*$)/,
  /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/,
  /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/,
];

// Python — top-level def / async def / class (indent 0 only, enforced below).
const PYTHON: Pattern[] = [
  /^(?:async\s+)?def\s+([A-Za-z0-9_]+)/,
  /^class\s+([A-Za-z0-9_]+)/,
];

// Rust — fn / struct / enum / trait / impl / mod, with optional pub/async.
const RUST: Pattern[] = [
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z0-9_]+)/,
  /^impl(?:<[^>]*>)?\s+(?:[A-Za-z0-9_:<>]+\s+for\s+)?([A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)/,
];

export interface SymbolSpan {
  /** 0-based inclusive line indices. */
  startIdx: number;
  endIdx: number;
  symbol: string;
}

/** Pluggable structural recogniser. A future tree-sitter/LSP adapter implements
 * the same interface and is selected by `adapterFor` without touching callers. */
export interface CodeStructureAdapter {
  readonly id: string;
  findSymbols(lines: string[]): SymbolSpan[];
}

/** Match a top-level (column-0) symbol start; returns its name or null. */
function matchStart(line: string, patterns: Pattern[]): string | null {
  if (/^\s/.test(line)) return null; // indented → not top-level
  for (const re of patterns) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * C-family symbol end: scan chars from `startIdx`, ignoring braces inside
 * strings (', ", `, the last spanning lines), line comments (//) and block
 * comments (/* *​/). End at the line where the curly body returns to depth 0, or
 * the first top-level `;` for a brace-less item (type alias, unit struct, arrow
 * const ending in `;`). Unterminated → EOF.
 */
function scanBracedEnd(lines: string[], startIdx: number): number {
  let curly = 0;
  let paren = 0;
  let bracket = 0;
  let sawCurly = false;
  let inBlockComment = false;
  let str: string | null = null; // persists across lines (template literals)

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inLineComment = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const next = c + 1 < line.length ? line[c + 1] : "";
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; c++; }
        continue;
      }
      if (str) {
        if (ch === "\\") { c++; continue; } // escape next char
        if (ch === str) str = null;
        continue;
      }
      if (ch === "/" && next === "/") { inLineComment = true; break; }
      if (ch === "/" && next === "*") { inBlockComment = true; c++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
      if (ch === "{") { curly++; sawCurly = true; }
      else if (ch === "}") { curly--; }
      else if (ch === "(") paren++;
      else if (ch === ")") paren--;
      else if (ch === "[") bracket++;
      else if (ch === "]") bracket--;
      else if (ch === ";" && !sawCurly && paren <= 0 && bracket <= 0) {
        return i; // brace-less declaration terminates here
      }
    }
    if (sawCurly && curly <= 0) return i; // body opened and fully closed
    // Brace-less, no `;`, nothing left open, and the line doesn't obviously
    // continue → a single-line item (e.g. `export type X = Y` sans semicolon).
    if (!sawCurly && paren <= 0 && bracket <= 0 && !looksContinued(line)) return i;
  }
  return lines.length - 1;
}

/** A trimmed line ending in an operator/opener is a multi-line continuation. */
function looksContinued(line: string): boolean {
  const t = line.replace(/\/\/.*$/, "").trimEnd();
  if (t === "") return true;
  return /[=,|&+\-<>(\[{:?.]$/.test(t);
}

/** Python symbol end: last non-blank line before the dedent back to column 0. */
function scanIndentEnd(lines: string[], startIdx: number): number {
  let lastContent = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // blanks don't end a block
    if (!/^\s/.test(line)) return lastContent; // back at column 0 → block ended
    lastContent = i;
  }
  return lastContent;
}

class StructuralAdapter implements CodeStructureAdapter {
  constructor(
    readonly id: string,
    private readonly patterns: Pattern[],
    private readonly scanEnd: (lines: string[], startIdx: number) => number,
  ) {}

  findSymbols(lines: string[]): SymbolSpan[] {
    const spans: SymbolSpan[] = [];
    let cursor = 0; // first line not yet consumed by a prior span
    for (let i = 0; i < lines.length; i++) {
      if (i < cursor) continue; // inside a found symbol's body
      const symbol = matchStart(lines[i], this.patterns);
      if (!symbol) continue;
      const endIdx = Math.max(i, this.scanEnd(lines, i));
      spans.push({ startIdx: i, endIdx, symbol });
      cursor = endIdx + 1;
    }
    return spans;
  }
}

/**
 * MEM-24 (0.4.4) — optional AST-backed adapter for TS/JS. Loads the TypeScript
 * compiler ONLY if it resolves at runtime — a dependency-light enhancement
 * (`typescript` is an OPTIONAL, dynamically-loaded peer, never a forced runtime
 * dep, so the default install carries no ~60 MB compiler). When present it parses
 * a real AST and reports exact top-level symbol spans (functions, classes,
 * interfaces, type aliases, enums, modules, and arrow/function/class consts) —
 * correctly handling regex/template literals, JSX, and decorators that the brace
 * scanner can't see. When absent (or on a parse error) it transparently falls
 * back to the MEM-18 structural brace scanner, so the no-dep install is unchanged.
 */
let tsModule: unknown | null | undefined; // undefined = untried, null = unavailable
function loadTypeScript(): any | null {
  if (tsModule !== undefined) return tsModule;
  try {
    tsModule = createRequire(import.meta.url)("typescript");
  } catch {
    tsModule = null;
  }
  return tsModule;
}

/** Test seam: drop the cached TS module so the loader is re-tried. */
export function __resetTsAdapterCacheForTests(): void {
  tsModule = undefined;
}

/** Name of a top-level statement that's a chunkable symbol, else null. */
function tsSymbolName(ts: any, stmt: any): string | null {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt.name.text;
  if (ts.isClassDeclaration(stmt) && stmt.name) return stmt.name.text;
  if (ts.isInterfaceDeclaration(stmt)) return stmt.name.text;
  if (ts.isTypeAliasDeclaration(stmt)) return stmt.name.text;
  if (ts.isEnumDeclaration(stmt)) return stmt.name.text;
  if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) return stmt.name.text;
  if (ts.isVariableStatement(stmt)) {
    const decl = stmt.declarationList.declarations[0];
    if (
      decl?.name && ts.isIdentifier(decl.name) && decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer) || ts.isClassExpression(decl.initializer))
    ) {
      return decl.name.text;
    }
  }
  return null;
}

class TypeScriptAstAdapter implements CodeStructureAdapter {
  readonly id = "tsjs-ast";
  constructor(private readonly fallback: CodeStructureAdapter, private readonly jsx: boolean) {}

  findSymbols(lines: string[]): SymbolSpan[] {
    const ts = loadTypeScript();
    if (!ts) return this.fallback.findSymbols(lines); // no typescript → structural scan
    try {
      const sf = ts.createSourceFile(
        this.jsx ? "f.tsx" : "f.ts",
        lines.join("\n"),
        ts.ScriptTarget.Latest,
        true,
        this.jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const spans: SymbolSpan[] = [];
      for (const stmt of sf.statements) {
        const symbol = tsSymbolName(ts, stmt);
        if (!symbol) continue;
        const startIdx = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line;
        const endIdx = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line;
        spans.push({ startIdx, endIdx: Math.max(startIdx, endIdx), symbol });
      }
      return spans;
    } catch {
      return this.fallback.findSymbols(lines); // parse error → structural scan
    }
  }
}

/** Select the structural adapter for a language hint / extension. Default TS/JS. */
export function adapterFor(language?: string): CodeStructureAdapter {
  const l = (language ?? "").toLowerCase().replace(/^\./, "").trim();
  if (l === "py" || l === "python") return new StructuralAdapter("python-indent", PYTHON, scanIndentEnd);
  if (l === "rs" || l === "rust") return new StructuralAdapter("rust-brace", RUST, scanBracedEnd);
  // TS/JS (and unknown → default): real AST when `typescript` resolves, else the
  // structural brace scanner (the AST adapter falls back internally).
  const structural = new StructuralAdapter("tsjs-brace", TS_JS, scanBracedEnd);
  return new TypeScriptAstAdapter(structural, l === "tsx" || l === "jsx");
}

/** Best-effort language from a file path's extension (for callers with a path). */
export function languageFromPath(path?: string | null): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path ?? "");
  return m ? m[1].toLowerCase() : undefined;
}

export interface CodeChunkOptions extends ChunkOptions {
  /** Language hint or file extension (e.g. "ts", "python", "rs"). Default TS/JS. */
  language?: string;
  /** Attached to every chunk's `filePath` (provenance). */
  filePath?: string | null;
}

export function chunkCode(text: string, opts: CodeChunkOptions = {}): SourceChunkInput[] {
  const maxTokens = opts.maxTokens ?? 500;
  const estimate = opts.estimate ?? estimateTokens;
  const filePath = opts.filePath ?? null;
  const normalized = text ?? "";
  if (!normalized.trim()) return [];

  const adapter = adapterFor(opts.language ?? languageFromPath(opts.filePath));
  const lines = normalized.split("\n");
  const spans = adapter.findSymbols(lines);

  // No recognised symbols → pure line-based fallback (no symbol labels).
  if (spans.length === 0) {
    return chunkSource(normalized, { maxTokens, estimate }).map((c) => ({ ...c, filePath }));
  }

  // Carve regions: symbol spans plus the gaps around them (preamble, between
  // symbols, trailer). Gaps are unlabelled; blank-only gaps are dropped.
  const regions: Array<{ startIdx: number; endIdx: number; symbol: string | null }> = [];
  let prevEnd = -1;
  for (const span of spans) {
    if (span.startIdx > prevEnd + 1) {
      regions.push({ startIdx: prevEnd + 1, endIdx: span.startIdx - 1, symbol: null });
    }
    regions.push({ startIdx: span.startIdx, endIdx: span.endIdx, symbol: span.symbol });
    prevEnd = span.endIdx;
  }
  if (prevEnd < lines.length - 1) {
    regions.push({ startIdx: prevEnd + 1, endIdx: lines.length - 1, symbol: null });
  }

  const chunks: SourceChunkInput[] = [];
  for (const region of regions) {
    const regionLines = lines.slice(region.startIdx, region.endIdx + 1);
    const content = regionLines.join("\n");
    if (!content.trim()) continue; // skip blank-only preamble/gaps

    const toks = estimate(content);
    // Fits in budget (or is a single line) → one chunk for the whole symbol/gap.
    if (toks <= maxTokens || regionLines.length === 1) {
      chunks.push({
        content,
        tokenCount: toks,
        filePath,
        symbol: region.symbol,
        startLine: region.startIdx + 1,
        endLine: region.endIdx + 1,
      });
      continue;
    }

    // Oversized region → sub-split by line packing, offsetting line numbers back
    // to the file and keeping the symbol name with a 1-based part suffix.
    const subs = chunkSource(content, { maxTokens, estimate });
    subs.forEach((s, idx) => {
      chunks.push({
        content: s.content,
        tokenCount: s.tokenCount,
        filePath,
        symbol: region.symbol ? `${region.symbol}#${idx + 1}` : null,
        startLine: (s.startLine ?? 1) + region.startIdx,
        endLine: (s.endLine ?? 1) + region.startIdx,
      });
    });
  }
  return chunks;
}
