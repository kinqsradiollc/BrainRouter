import type { SourceChunkInput } from "@kinqs/brainrouter-types";

/**
 * 0.4.3 Brain Phase 2 (MEM-2) — token-aware source chunker.
 *
 * Greedily packs whole lines into chunks up to a token budget so captured
 * sources (transcript turns, tool output, files) become retrievable,
 * citable chunks. Lines are never split mid-line — a single over-budget line
 * becomes its own chunk — so code/log/test lines stay intact for evidence.
 * The estimator is injectable so a shared tokenizer contract can replace the
 * default chars/4 heuristic (matches `memory/working/offload.ts`) later.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChunkOptions {
  /** Target max tokens per chunk. Default 500. */
  maxTokens?: number;
  /** Override the token estimator (future shared-tokenizer contract). */
  estimate?: (text: string) => number;
}

export function chunkSource(text: string, opts: ChunkOptions = {}): SourceChunkInput[] {
  const maxTokens = opts.maxTokens ?? 500;
  const estimate = opts.estimate ?? estimateTokens;
  const normalized = text ?? "";
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const chunks: SourceChunkInput[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let startLine = 1; // 1-based

  const flush = (endLine: number): void => {
    if (buf.length === 0) return;
    const content = buf.join("\n");
    chunks.push({ content, tokenCount: estimate(content), startLine, endLine });
    buf = [];
    bufTokens = 0;
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const lineTokens = estimate(line);
    // Close the current chunk before a line that would push it over budget
    // (but never flush an empty buffer — an over-budget line stands alone).
    if (bufTokens > 0 && bufTokens + lineTokens > maxTokens) {
      flush(lineNo - 1);
      startLine = lineNo;
    }
    buf.push(line);
    bufTokens += lineTokens;
  });
  flush(lines.length);
  return chunks;
}
