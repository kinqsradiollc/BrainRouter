/**
 * ADR-029 F3 — the arrow keys, decided against the LAYOUT rather than against
 * the newlines.
 *
 * Part E measured "am I on the first line" by looking for a `\n` before the
 * caret. That is testable and wrong in the commonest case there is: a paragraph
 * long enough to wrap has no newline in it at all, so every visual row of it
 * counted as the first one — press ArrowUp anywhere in a wrapped paragraph and
 * the caret left the block entirely instead of climbing one row. Part E said as
 * much in its own comment and called it "the honest limit of a judgement made
 * without a layout". F3 removes the limit rather than the honesty.
 *
 * **The component measures; this file decides.** A `getClientRects()` call is
 * the only way to know where the rows actually are, and it can only happen where
 * the DOM is — but *which* row the caret is on, whether that row is an edge, and
 * where a caret arriving from another block should land are judgements, and a
 * judgement inside a keydown handler is one nobody can test and one the
 * dashboard will make differently.
 *
 * Every function here takes plain numbers. There is no DOM type in this file on
 * purpose: that is what lets the whole of the arrow-key behaviour be pinned by a
 * test that never opens a browser.
 */

/** One laid-out row of a block, as the browser reports it. */
export interface RowRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CaretRect {
  top: number;
  bottom: number;
  /** Where the caret sits horizontally — the column an arrow key preserves. */
  left: number;
}

export interface VisualRowGeometry {
  /** The block's rows, in document order. Empty when the block has no text. */
  rows: readonly RowRect[];
  caret: CaretRect;
}

/**
 * How much vertical slack counts as "the same row".
 *
 * A caret rect is not the same height as the line box it sits in: a row
 * containing a larger inline mark, an emoji or a reference chip is taller than
 * the caret in it, and the caret is vertically centred rather than aligned to
 * the top. Comparing the caret's MIDPOINT against each row's span is what makes
 * that irrelevant; the tolerance covers the sub-pixel rounding that remains.
 */
const SLACK = 1;

function midpoint(rect: { top: number; bottom: number }): number {
  return (rect.top + rect.bottom) / 2;
}

/**
 * Which row the caret is on, or -1 when there is nothing laid out.
 *
 * Falls back to the NEAREST row rather than refusing. A caret whose midpoint
 * lands in the gap between two line boxes — possible with line-height under 1 —
 * has to be on one of them, and answering "neither" would make the arrow key do
 * nothing at all, which is the failure this file exists to remove.
 */
export function visualRowIndex(geometry: VisualRowGeometry): number {
  const { rows, caret } = geometry;
  if (rows.length === 0) return -1;
  const y = midpoint(caret);

  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (y >= row.top - SLACK && y <= row.bottom + SLACK) return at;
  }

  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let at = 0; at < rows.length; at += 1) {
    const distance = Math.abs(midpoint(rows[at]!) - y);
    if (distance < best) { best = distance; nearest = at; }
  }
  return nearest;
}

/**
 * Is the caret on the block's first visual row — the one ArrowUp leaves from?
 *
 * A block with NO rows (an empty paragraph someone just made) is on its first
 * and its last row at once, which is correct: there is one row and the caret is
 * in it. Answering `false` would strand the caret in an empty block that the
 * arrows could not leave, which is precisely how a new line at the end of a page
 * becomes a trap.
 */
export function atFirstVisualRow(geometry: VisualRowGeometry): boolean {
  const index = visualRowIndex(geometry);
  return index <= 0;
}

export function atLastVisualRow(geometry: VisualRowGeometry): boolean {
  const index = visualRowIndex(geometry);
  return index < 0 || index === geometry.rows.length - 1;
}

/**
 * Where a caret arriving from the block above (or below) should be placed.
 *
 * An X COORDINATE and a Y, not a character column. On a wrapped paragraph a
 * column is meaningless — "column 40" of a block whose first row holds 62
 * characters and whose second holds 18 is two entirely different places — and
 * the thing a person is actually tracking with their eyes is the horizontal
 * position. So the caret enters at the same x, on the target's first or last
 * row, and the caller hit-tests that point.
 *
 * The x is CLAMPED into the target row. Arriving beyond the end of a short line
 * would otherwise hit-test past the text and land wherever the browser felt
 * like, which is the one outcome worse than losing the column.
 */
export function caretEntryPoint(
  rows: readonly RowRect[],
  edge: 'first' | 'last',
  x: number,
): { x: number; y: number } | null {
  if (rows.length === 0) return null;
  const row = edge === 'first' ? rows[0]! : rows[rows.length - 1]!;
  return {
    x: Math.min(Math.max(x, row.left), Math.max(row.left, row.right - 1)),
    y: midpoint(row),
  };
}

/**
 * The rows a caller measured, filtered down to the ones that are really rows.
 *
 * `getClientRects()` over a range that spans element boundaries reports a rect
 * per element as well as per line, so a row containing a bold run and a
 * reference chip arrives as three overlapping rects. Merging by vertical span
 * turns them back into the one row a reader sees — without which a wrapped
 * paragraph would report five rows for two and ArrowUp would refuse to leave a
 * block it is at the top of.
 */
export function mergeRowRects(rects: readonly RowRect[]): RowRect[] {
  const out: RowRect[] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    // A zero-height rect is a collapsed boundary between two elements, not a
    // row; keeping it would put an extra "row" at the start of every block whose
    // text begins with a chip.
    if (rect.bottom - rect.top <= 0) continue;
    const last = out[out.length - 1];
    if (last && midpoint(rect) >= last.top - SLACK && midpoint(rect) <= last.bottom + SLACK) {
      last.top = Math.min(last.top, rect.top);
      last.bottom = Math.max(last.bottom, rect.bottom);
      last.left = Math.min(last.left, rect.left);
      last.right = Math.max(last.right, rect.right);
      continue;
    }
    out.push({ ...rect });
  }
  return out;
}
