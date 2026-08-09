/**
 * Diff-shaped helpers the PR review path needs on top of what core exposes.
 *
 * The SIZE-based split below is no longer how a review is divided — ADR-033 D2
 * replaced it with bundles of related files, because size is the one property
 * of a change that carries no meaning. It survives as the last-resort packer
 * for a diff whose sections carry no attributable path, and it now delegates
 * the actual splitting to core so there is exactly one implementation of "where
 * does a diff come apart".
 */
import type { ParsedReviewFinding } from "@kinqs/brainrouter-core/review";
import { splitDiffFileByHunk, splitUnifiedDiffFiles } from "@kinqs/brainrouter-core/review";
import type { AssuranceSourceLocation } from "@kinqs/brainrouter-types/review";

/**
 * Pack `diff` into chunks each ≤ `maxChars` where possible. A diff already
 * within budget is returned as a single chunk. An individual hunk larger than
 * `maxChars` is kept whole rather than mangled.
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
  for (const file of splitUnifiedDiffFiles(diff)) {
    if (file.diff.length > maxChars) { for (const piece of splitDiffFileByHunk(file.diff)) add(piece); }
    else add(file.diff);
  }
  flush();
  return chunks.length > 0 ? chunks : [diff];
}

/**
 * Convert a unified diff into bounded new-revision source ranges. Contiguous
 * additions become one anchor; rename/binary/deletion-only sections retain a
 * path-only anchor so exact-source coverage never silently drops a changed
 * file merely because GitHub has no RIGHT-side line for it.
 */
export function changedSourceLocations(diff: string): AssuranceSourceLocation[] {
  const locations: AssuranceSourceLocation[] = [];
  let path: string | null = null;
  let newLine = 0;
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;
  let sectionHasAnchor = false;
  let inHunk = false;

  const flushRange = (): void => {
    if (!path || rangeStart === null || rangeEnd === null) return;
    locations.push({
      path,
      line: rangeStart,
      ...(rangeEnd > rangeStart ? { endLine: rangeEnd } : {}),
    });
    sectionHasAnchor = true;
    rangeStart = null;
    rangeEnd = null;
  };
  const flushSection = (): void => {
    flushRange();
    if (path && !sectionHasAnchor) locations.push({ path });
    path = null;
    sectionHasAnchor = false;
    inHunk = false;
  };

  for (const raw of (diff ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushSection();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      path = match?.[2] ?? null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      flushRange();
      const candidate = raw.slice(4).replace(/^b\//, "").trim();
      if (candidate !== "/dev/null") path = candidate;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flushRange();
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;
    if (raw.startsWith("+")) {
      if (rangeStart === null) rangeStart = newLine;
      rangeEnd = newLine;
      newLine += 1;
    } else if (raw.startsWith("-")) {
      flushRange();
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" is metadata, not source.
    } else {
      flushRange();
      newLine += 1;
    }
  }
  flushSection();

  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line ?? 0}:${location.endLine ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Merging findings across review units now lives in core next to the parser it
 * feeds (ADR-033 D2): with bundles running concurrently every reviewing surface
 * needs it, and two copies of "the same finding" would drift apart. Re-exported
 * so this module's consumers keep one import.
 */
export { dedupeReviewFindings } from "@kinqs/brainrouter-core/review";
