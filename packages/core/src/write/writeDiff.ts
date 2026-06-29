/**
 * WRITE MODE — diff-review primitive (§2 W2).
 *
 * The heart of selection-driven inline AI: when the assistant rewrites a span of
 * prose, the user reviews the change as red/green per-chunk hunks and
 * accepts/rejects each one before it lands. This module is the pure, dependency-
 * free core — a line-level LCS diff grouped into review chunks, plus a
 * reconstruction that applies a per-chunk accept/reject decision. The CodeMirror
 * decorations (W2 UI) and the selection agent (W3) render + drive this; all logic
 * here is unit-tested.
 */

export type ReviewOp = 'equal' | 'insert' | 'delete' | 'replace';

export interface ReviewChunk {
  /** Stable index into the chunk list (the decision key). */
  id: number;
  op: ReviewOp;
  /** Original text for this chunk (newline-joined lines); '' for a pure insert. */
  original: string;
  /** Revised text for this chunk; '' for a pure delete. */
  revised: string;
}

export type ReviewDecision = 'accept' | 'reject';

/** Above this many lines on either side, skip the O(n·m) DP and emit a single
 *  whole-document replace chunk (still reviewable, just not line-granular). */
const MAX_DIFF_LINES = 4000;

type LineOp = { op: 'equal' | 'delete' | 'insert'; a?: string; b?: string };

/** Classic LCS line diff (backward DP + forward walk). Deterministic; on a tie
 *  it prefers `delete` so equal runs stay maximal and grouping is stable. */
function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: 'equal', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'delete', a: a[i] }); i++; }
    else { ops.push({ op: 'insert', b: b[j] }); j++; }
  }
  while (i < n) { ops.push({ op: 'delete', a: a[i] }); i++; }
  while (j < m) { ops.push({ op: 'insert', b: b[j] }); j++; }
  return ops;
}

/**
 * Diff `original` → `revised` as a list of review chunks. Consecutive equal lines
 * collapse into one `equal` chunk; a run of deletes and/or inserts collapses into
 * one chunk — `delete` (only removals), `insert` (only additions), or `replace`
 * (both). Chunk ids are contiguous from 0 in document order.
 */
export function computeReviewChunks(original: string, revised: string): ReviewChunk[] {
  if (original === revised) {
    return original === '' ? [] : [{ id: 0, op: 'equal', original, revised }];
  }
  const aLines = original.split('\n');
  const bLines = revised.split('\n');

  if (aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES) {
    return [{ id: 0, op: 'replace', original, revised }];
  }

  const ops = diffLines(aLines, bLines);
  const chunks: ReviewChunk[] = [];
  let id = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 'equal') {
      const eq: string[] = [];
      while (i < ops.length && ops[i].op === 'equal') { eq.push(ops[i].a as string); i++; }
      const text = eq.join('\n');
      chunks.push({ id: id++, op: 'equal', original: text, revised: text });
      continue;
    }
    // a maximal run of deletes/inserts → one change chunk
    const dels: string[] = [];
    const ins: string[] = [];
    while (i < ops.length && ops[i].op !== 'equal') {
      if (ops[i].op === 'delete') dels.push(ops[i].a as string);
      else ins.push(ops[i].b as string);
      i++;
    }
    const op: ReviewOp = dels.length && ins.length ? 'replace' : dels.length ? 'delete' : 'insert';
    chunks.push({ id: id++, op, original: dels.join('\n'), revised: ins.join('\n') });
  }
  return chunks;
}

/**
 * Reconstruct the document from a review: `equal` chunks always contribute their
 * text; a change chunk contributes its `revised` when accepted and its `original`
 * when rejected. `decisions` is keyed by chunk id; chunks without an explicit
 * decision use `defaultDecision` (default 'accept'). Pure inserts contribute
 * nothing when rejected; pure deletes contribute nothing when accepted — and the
 * surrounding newline structure is preserved by joining non-empty segments with
 * the original line separators.
 */
export function applyReview(
  chunks: ReviewChunk[],
  decisions: Record<number, ReviewDecision>,
  defaultDecision: ReviewDecision = 'accept',
): string {
  const segments: string[] = [];
  for (const c of chunks) {
    if (c.op === 'equal') { segments.push(c.original); continue; }
    const decision = decisions[c.id] ?? defaultDecision;
    segments.push(decision === 'accept' ? c.revised : c.original);
  }
  // Drop segments that are '' ONLY when they correspond to a fully-removed change
  // (e.g. an accepted delete or a rejected insert) so we don't introduce blank
  // lines; equal/other segments (which may legitimately be '') are kept.
  return joinSegments(chunks, segments);
}

/** Join segments with '\n', skipping the empty string a change chunk yields when
 *  its chosen side is empty (accepted delete / rejected insert) — those chunks
 *  contribute no line at all, rather than an empty line. */
function joinSegments(chunks: ReviewChunk[], segments: string[]): string {
  const kept: string[] = [];
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const seg = segments[k];
    const isEmptiedChange = c.op !== 'equal' && seg === '';
    if (isEmptiedChange) continue;
    kept.push(seg);
  }
  return kept.join('\n');
}

/** Convenience: accept every change (the revised document) — the identity check
 *  for the diff (computeReviewChunks then acceptAll should equal `revised`). */
export function acceptAll(chunks: ReviewChunk[]): string {
  return applyReview(chunks, {}, 'accept');
}

/** Convenience: reject every change (back to the original document). */
export function rejectAll(chunks: ReviewChunk[]): string {
  return applyReview(chunks, {}, 'reject');
}

export interface ReviewStats {
  added: number;
  removed: number;
  changed: number;
  /** Total change chunks (added + removed + changed), i.e. reviewable hunks. */
  hunks: number;
}

/** Count insert/delete/replace chunks for a compact "+N −M ~K" review header. */
export function reviewStats(chunks: ReviewChunk[]): ReviewStats {
  let added = 0, removed = 0, changed = 0;
  for (const c of chunks) {
    if (c.op === 'insert') added++;
    else if (c.op === 'delete') removed++;
    else if (c.op === 'replace') changed++;
  }
  return { added, removed, changed, hunks: added + removed + changed };
}
