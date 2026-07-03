/**
 * Atlas — symbol extraction (ATLAS-2)
 *
 * Dependency-free, line-based symbol extraction for the common languages:
 * functions, classes, and import specifiers, with best-effort line ranges
 * (brace-matching for C-like languages, indentation for Python). This is
 * intentionally lighter than a full AST parse — it keeps `core` lean (no
 * tree-sitter / typescript runtime dep) while producing enough structure for a
 * useful knowledge graph. LLM enrichment (ATLAS-4) layers summaries + semantic
 * edges on top.
 */

export interface ExtractedSymbol {
  kind: "function" | "class";
  name: string;
  /** 1-indexed inclusive `[start, end]`. */
  lineRange: [number, number];
}

export interface ExtractedImport {
  /** Raw module specifier as written (`./util`, `react`, `os`). */
  module: string;
  /** 1-indexed line. */
  line: number;
}

export interface FileSymbols {
  functions: ExtractedSymbol[];
  classes: ExtractedSymbol[];
  imports: ExtractedImport[];
}

interface LangSpec {
  /** Languages this spec applies to. */
  langs: string[];
  /** Block delimiter style for end-of-symbol detection. */
  blocks: "brace" | "indent";
  /** Patterns whose capture group 1 is a function name. */
  fn: RegExp[];
  /** Patterns whose capture group 1 is a class/struct/type name. */
  cls: RegExp[];
  /** Patterns whose capture group 1 is an imported module specifier. */
  imp: RegExp[];
}

const SPECS: LangSpec[] = [
  {
    langs: ["typescript", "javascript", "vue", "svelte"],
    blocks: "brace",
    fn: [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      /^\s*(?:public|private|protected|static|async|get|set|\s)*\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{/,
    ],
    cls: [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
    imp: [/\bimport\b[^'"]*['"]([^'"]+)['"]/, /\bexport\b[^'"]*\bfrom\s+['"]([^'"]+)['"]/, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/],
  },
  {
    langs: ["python"],
    blocks: "indent",
    fn: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
    cls: [/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/],
    imp: [/^\s*import\s+([A-Za-z_][\w.]*)/, /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\b/],
  },
  {
    langs: ["go"],
    blocks: "brace",
    fn: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[<(]/],
    cls: [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
    imp: [/^\s*import\s+(?:[A-Za-z_.]\w*\s+)?["`]([^"`]+)["`]/, /^\s*["`]([^"`]+)["`]\s*$/],
  },
  {
    langs: ["rust"],
    blocks: "brace",
    fn: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/],
    cls: [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
    imp: [/^\s*use\s+([A-Za-z_][\w:]*)/],
  },
  {
    langs: ["java", "csharp", "kotlin", "scala"],
    blocks: "brace",
    fn: [/^\s*(?:public|private|protected|internal|static|final|override|suspend|fun|async|\s)*\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:[:A-Za-z_<>\[\],.\s]+)?\{/],
    cls: [/^\s*(?:public|private|protected|internal|abstract|sealed|final|data|\s)*\b(?:class|interface|object|enum|struct|record)\s+([A-Za-z_]\w*)/],
    imp: [/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)/, /^\s*using\s+([A-Za-z_][\w.]*)\s*;/],
  },
  {
    langs: ["ruby"],
    blocks: "indent",
    fn: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/],
    cls: [/^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/],
    imp: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/],
  },
  {
    langs: ["php"],
    blocks: "brace",
    fn: [/^\s*(?:public|private|protected|static|final|abstract|\s)*function\s+([A-Za-z_]\w*)\s*\(/],
    cls: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/],
    imp: [/^\s*use\s+([A-Za-z_][\w\\]*)/, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/],
  },
  {
    langs: ["c", "cpp", "objc"],
    blocks: "brace",
    fn: [/^\s*(?:[A-Za-z_][\w:<>*&\s]+?)\s+\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/],
    cls: [/^\s*(?:class|struct)\s+([A-Za-z_]\w*)/],
    imp: [/^\s*#\s*include\s+[<"]([^>"]+)[>"]/],
  },
];

function specFor(language: string): LangSpec | undefined {
  return SPECS.find((s) => s.langs.includes(language));
}

const LEADING_WS = /^(\s*)/;
function indentOf(line: string): number {
  return (LEADING_WS.exec(line)?.[1].length ?? 0);
}

/** End line of a brace-delimited block starting at (1-indexed) startLine. */
function braceBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = stripStringsAndComments(lines[i]);
    for (const ch of line) {
      if (ch === "{") { depth++; seenOpen = true; }
      else if (ch === "}") { depth--; if (seenOpen && depth <= 0) return i + 1; }
    }
    if (i - startIdx > 4000) break; // safety
  }
  return Math.min(startIdx + 1, lines.length);
}

/** End line of an indentation block (Python/Ruby) starting at startIdx. */
function indentBlockEnd(lines: string[], startIdx: number): number {
  const baseIndent = indentOf(lines[startIdx]);
  let end = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { end = i; continue; }
    if (indentOf(line) <= baseIndent) break;
    end = i;
  }
  return end + 1;
}

/** Cheap removal of string/line-comment content so braces inside them don't skew depth. */
function stripStringsAndComments(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/#.*$/, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

const RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class", "else",
  "do", "try", "with", "match", "when", "case", "select", "defer", "go",
]);

/**
 * Extract functions, classes, and imports from a source file. Returns empty
 * lists for unsupported languages (the file still becomes a node, just without
 * child symbols).
 */
export function extractSymbols(language: string, source: string): FileSymbols {
  const spec = specFor(language);
  const out: FileSymbols = { functions: [], classes: [], imports: [] };
  if (!spec) return out;

  const lines = source.split(/\r?\n/);
  const seenFn = new Set<string>();
  const seenCls = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    for (const re of spec.imp) {
      const m = re.exec(line);
      if (m && m[1]) { out.imports.push({ module: m[1], line: i + 1 }); break; }
    }

    let matched = false;
    for (const re of spec.cls) {
      const m = re.exec(line);
      if (m && m[1] && !RESERVED.has(m[1])) {
        const end = spec.blocks === "brace" ? braceBlockEnd(lines, i) : indentBlockEnd(lines, i);
        const key = `${m[1]}:${i}`;
        if (!seenCls.has(key)) { out.classes.push({ kind: "class", name: m[1], lineRange: [i + 1, end] }); seenCls.add(key); }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const re of spec.fn) {
      const m = re.exec(line);
      if (m && m[1] && !RESERVED.has(m[1])) {
        const end = spec.blocks === "brace" ? braceBlockEnd(lines, i) : indentBlockEnd(lines, i);
        const key = `${m[1]}:${i}`;
        if (!seenFn.has(key)) { out.functions.push({ kind: "function", name: m[1], lineRange: [i + 1, end] }); seenFn.add(key); }
        break;
      }
    }
  }

  return out;
}
