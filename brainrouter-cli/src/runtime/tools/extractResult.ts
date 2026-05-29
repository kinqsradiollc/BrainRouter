/**
 * MAS-P5-T2 (0.4.2) — `extract_result` tool.
 *
 * When a tool result was handed off (see `runtime/resultHandoff.ts`), the
 * model holds a `resultRef` instead of the full blob. `extract_result`
 * lets it pull just the part it needs — either a head window (no query) or
 * the lines matching `query` with surrounding context — without paying to
 * re-stream the whole thing into context.
 *
 * The extraction itself is pure (`extractFromResult`); the tool handler is
 * a thin lookup against the session {@link ResultCache}.
 */

import type { ResultCache } from "../resultHandoff.js";

export const EXTRACT_RESULT_MAX_CHARS = 4000;
export const EXTRACT_RESULT_CONTEXT_LINES = 2;

export interface ExtractResultArgs {
  resultRef: string;
  query?: string;
  maxChars?: number;
  contextLines?: number;
}

export interface ExtractResultOutput {
  resultRef: string;
  found: boolean;
  query?: string;
  bytes: number;
  returned: string;
  matchedLines: number;
  truncated: boolean;
}

/**
 * Pure extraction. With no `query`, returns the head `maxChars`. With a
 * `query`, returns each matching line (case-insensitive substring) plus
 * `contextLines` of surrounding context, merging overlapping windows,
 * capped at `maxChars`.
 */
export function extractFromResult(
  text: string,
  query?: string,
  opts?: { maxChars?: number; contextLines?: number },
): { returned: string; matchedLines: number; truncated: boolean } {
  const maxChars = opts?.maxChars ?? EXTRACT_RESULT_MAX_CHARS;
  const contextLines = Math.max(0, opts?.contextLines ?? EXTRACT_RESULT_CONTEXT_LINES);

  const q = query?.trim();
  if (!q) {
    const truncated = text.length > maxChars;
    return { returned: truncated ? text.slice(0, maxChars) : text, matchedLines: 0, truncated };
  }

  const lines = text.split("\n");
  const needle = q.toLowerCase();
  const hitIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) hitIdx.push(i);
  }
  if (hitIdx.length === 0) {
    return { returned: `No lines matched "${q}".`, matchedLines: 0, truncated: false };
  }

  // Merge overlapping context windows into ranges.
  const ranges: Array<[number, number]> = [];
  for (const i of hitIdx) {
    const lo = Math.max(0, i - contextLines);
    const hi = Math.min(lines.length - 1, i + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  for (let r = 0; r < ranges.length; r++) {
    const [lo, hi] = ranges[r];
    const header = r === 0 ? "" : "\n…\n";
    const body = lines
      .slice(lo, hi + 1)
      .map((l, k) => `${lo + k + 1}: ${l}`)
      .join("\n");
    const piece = header + body;
    if (used + piece.length > maxChars) {
      truncated = true;
      break;
    }
    chunks.push(piece);
    used += piece.length;
  }

  return { returned: chunks.join(""), matchedLines: hitIdx.length, truncated };
}

export const EXTRACT_RESULT_TOOL_SCHEMA = {
  name: "extract_result",
  description:
    "Pull part of a large tool result that was handed off (you hold a `resultRef` instead of the full output). With no `query`, returns the head of the result; with a `query`, returns the matching lines plus surrounding context. Use this instead of re-running the original tool when you only need a slice of a big output.",
  inputSchema: {
    type: "object",
    properties: {
      resultRef: { type: "string", description: "The resultRef from a handed-off tool result." },
      query: { type: "string", description: "Optional case-insensitive substring to search for." },
      maxChars: { type: "number", description: "Cap on returned chars (default 4000)." },
    },
    required: ["resultRef"],
  },
} as const;

/** Tool handler: look up the ref in the session cache and extract. */
export function runExtractResult(args: ExtractResultArgs, cache: ResultCache): ExtractResultOutput {
  const text = cache.get(args.resultRef);
  if (text === undefined) {
    return {
      resultRef: args.resultRef,
      found: false,
      query: args.query,
      bytes: 0,
      returned:
        "[resultRef not found or expired in the session cache. Re-run the original tool, or if it was offloaded durably, read it back via memory_working_offload.]",
      matchedLines: 0,
      truncated: false,
    };
  }
  const ex = extractFromResult(text, args.query, { maxChars: args.maxChars, contextLines: args.contextLines });
  return {
    resultRef: args.resultRef,
    found: true,
    query: args.query,
    bytes: text.length,
    returned: ex.returned,
    matchedLines: ex.matchedLines,
    truncated: ex.truncated,
  };
}
