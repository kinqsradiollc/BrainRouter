/**
 * Chunk a PR's unified diff so the reviewer can cover ALL of it instead of the
 * single-shot review's first N characters. This is what turns a review into a
 * turn-based loop (see "Types of Loops"): a diff within budget is one chunk (one
 * turn — identical to the old single-shot behaviour), a larger diff becomes
 * several turns that together review every file. Splitting follows file (`diff
 * --git`) boundaries first and hunk (`@@`) boundaries only when one file alone
 * exceeds the budget, so a chunk is always a coherent, self-describing diff.
 */
import type { ParsedReviewFinding } from "@kinqs/brainrouter-core/review";

/** Split a unified diff into per-file sections (header line kept with its body). */
function splitByFile(diff: string): string[] {
  const files: string[] = [];
  let buf: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && buf.length) { files.push(buf.join("\n")); buf = []; }
    buf.push(line);
  }
  if (buf.length) files.push(buf.join("\n"));
  return files;
}

/** Split ONE oversized file section into `<file header>\n<hunk>` pieces. */
function splitFileByHunk(file: string): string[] {
  const lines = file.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk < 0) return [file]; // no hunks (binary/rename) → indivisible
  const header = lines.slice(0, firstHunk).join("\n");
  const hunks: string[] = [];
  let buf: string[] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@") && buf.length) { hunks.push(buf.join("\n")); buf = []; }
    buf.push(line);
  }
  if (buf.length) hunks.push(buf.join("\n"));
  return hunks.map((h) => `${header}\n${h}`);
}

/**
 * Split `diff` into review chunks each ≤ `maxChars` where possible. A diff already
 * within budget is returned as a single chunk (unchanged single-pass behaviour).
 * An individual hunk larger than `maxChars` is kept whole rather than mangled.
 */
export function splitDiffForReview(diff: string, maxChars: number): string[] {
  if (!diff) return [];
  if (diff.length <= maxChars || maxChars <= 0) return [diff];
  const chunks: string[] = [];
  let current = "";
  const flush = () => { if (current) { chunks.push(current); current = ""; } };
  const add = (piece: string) => {
    if (piece.length > maxChars) { flush(); chunks.push(piece); return; } // indivisible → own chunk
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= maxChars) current += "\n" + piece;
    else { flush(); current = piece; }
  };
  for (const file of splitByFile(diff)) {
    if (file.length > maxChars) { for (const piece of splitFileByHunk(file)) add(piece); }
    else add(file);
  }
  flush();
  return chunks.length > 0 ? chunks : [diff];
}

/**
 * Merge findings gathered across chunks, dropping duplicates. Two findings are
 * "the same" when they name the same file, line, and summary — so a finding on a
 * file that straddled a chunk boundary is reported once.
 */
export function dedupeReviewFindings(findings: ParsedReviewFinding[]): ParsedReviewFinding[] {
  const seen = new Set<string>();
  const out: ParsedReviewFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.file}\n${finding.line ?? ""}\n${finding.summary.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}
