import type { SourceChunkInput } from "@kinqs/brainrouter-types";
import { chunkSource, estimateTokens, type ChunkOptions } from "./chunker.js";

/**
 * 0.4.3 Brain Phase 2 (MEM-6) — symbol-aware code chunker.
 *
 * Splits source code at TOP-LEVEL definition boundaries (functions, classes,
 * etc.) so each chunk is a coherent unit of meaning rather than an arbitrary
 * line window — which makes retrieval hits land on a whole symbol and keeps a
 * definition's evidence together. Each chunk carries the symbol name and 1-based
 * line range.
 *
 * This is a heuristic first-cut, NOT a parser: boundaries are recognised by
 * lightweight per-language patterns on UNINDENTED lines (top-level symbols
 * only — nested members stay inside their parent's chunk). When no symbols are
 * recognised it falls back to the line-based `chunkSource`, and an oversized
 * symbol is sub-split the same way (its parts keep the symbol name with a
 * `#n` suffix). A real tree-sitter/LSP pass can replace the boundary detector
 * later without changing the chunk contract.
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

/** Normalise a language hint / file extension to a pattern set. Default TS/JS. */
function patternsFor(language?: string): Pattern[] {
  const l = (language ?? "").toLowerCase().replace(/^\./, "").trim();
  if (l === "py" || l === "python") return PYTHON;
  if (l === "rs" || l === "rust") return RUST;
  return TS_JS; // ts, tsx, js, jsx, mjs, cjs, typescript, javascript, unknown
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

  const patterns = patternsFor(opts.language ?? languageFromPath(opts.filePath));
  const lines = normalized.split("\n");

  // Top-level symbol boundaries: a 0-indent line matching a definition pattern.
  const boundaries: Array<{ line: number; symbol: string }> = [];
  lines.forEach((line, i) => {
    if (/^\s/.test(line)) return; // indented → not a top-level symbol
    for (const re of patterns) {
      const m = re.exec(line);
      if (m) {
        boundaries.push({ line: i, symbol: m[1] });
        break;
      }
    }
  });

  // No recognised symbols → pure line-based fallback (no symbol labels).
  if (boundaries.length === 0) {
    return chunkSource(normalized, { maxTokens, estimate }).map((c) => ({ ...c, filePath }));
  }

  // Carve regions: optional preamble (imports/license) then one per symbol,
  // each running until the next symbol begins.
  const regions: Array<{ startIdx: number; endIdx: number; symbol: string | null }> = [];
  if (boundaries[0].line > 0) {
    regions.push({ startIdx: 0, endIdx: boundaries[0].line - 1, symbol: null });
  }
  boundaries.forEach((b, k) => {
    const endIdx = k + 1 < boundaries.length ? boundaries[k + 1].line - 1 : lines.length - 1;
    regions.push({ startIdx: b.line, endIdx, symbol: b.symbol });
  });

  const chunks: SourceChunkInput[] = [];
  for (const region of regions) {
    const regionLines = lines.slice(region.startIdx, region.endIdx + 1);
    const content = regionLines.join("\n");
    if (!content.trim()) continue; // skip blank-only preamble/gaps
    const toks = estimate(content);

    // Fits in budget (or is a single line) → one chunk for the whole symbol.
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

    // Oversized symbol → sub-split by line packing, offsetting line numbers
    // back to the file and keeping the symbol name with a 1-based part suffix.
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
