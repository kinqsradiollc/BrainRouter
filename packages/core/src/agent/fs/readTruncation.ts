/**
 * CC-P7.3 — tool-result truncation contract (0.4.15 thread C).
 *
 * A full-file `read_file` (no line range) previously returned the ENTIRE file
 * into context — a 5,000-line file would blow the window in one call. The
 * strong reference agents cap a default read and tell the model exactly how to
 * get the rest (offset/limit / startLine-endLine). This is that cap: when an
 * unbounded read exceeds the line/char budget, return the head plus an explicit
 * "+N more lines — reread with startLine/endLine" notice so nothing is silently
 * lost. A range read (the model asked for specific lines) is never truncated.
 * Pure → unit-tested.
 */

/** Default cap for an unbounded full-file read. */
export const READ_FILE_MAX_LINES = 600;
/** Hard character ceiling (guards a file of few but enormous lines). */
export const READ_FILE_MAX_CHARS = 40_000;

export interface TruncationResult {
  text: string;
  truncated: boolean;
  shownLines: number;
  totalLines: number;
}

/**
 * Apply the unbounded-read cap to `content`. Returns the (possibly truncated)
 * text and metadata. `path` is only used to phrase the reread hint. Pure.
 */
export function truncateFullRead(
  content: string,
  path: string,
  opts?: { maxLines?: number; maxChars?: number },
): TruncationResult {
  const maxLines = opts?.maxLines ?? READ_FILE_MAX_LINES;
  const maxChars = opts?.maxChars ?? READ_FILE_MAX_CHARS;
  const lines = content.split('\n');
  const totalLines = lines.length;

  const withinLines = totalLines <= maxLines;
  const withinChars = content.length <= maxChars;
  if (withinLines && withinChars) {
    return { text: content, truncated: false, shownLines: totalLines, totalLines };
  }

  // Cap by lines first, then enforce the char ceiling on the head.
  let head = lines.slice(0, maxLines);
  let shownLines = head.length;
  let text = head.join('\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    // recompute shown lines after the char cut
    shownLines = text.split('\n').length;
  }
  const remaining = totalLines - shownLines;
  const notice =
    `\n\n[... truncated — showing lines 1-${shownLines} of ${totalLines}. ` +
    `${remaining} more line(s). Reread a later range with ` +
    `read_file("${path}", startLine=${shownLines + 1}) (and endLine to bound it), ` +
    `or grep_search the file for what you need.]`;
  return { text: text + notice, truncated: true, shownLines, totalLines };
}
