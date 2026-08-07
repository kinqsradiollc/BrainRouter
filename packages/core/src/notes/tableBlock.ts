/**
 * ADR-029 E4 — a table, without a second store.
 *
 * A table is a `table` block whose children are `table-row` blocks. That is not
 * a shortcut; it is what makes the table inherit everything Part B already
 * decided. Two people editing different rows never conflict, because B1's merge
 * granularity is the block and a row IS a block. A row syncs on its own ordered
 * outbox stream (B3). A row can be moved with the same rank arithmetic every
 * other sibling uses. A cells table stored as one JSON blob on the `table`
 * block would have had none of that: every edit to any cell would be a
 * whole-field write, and two people typing in different columns would produce
 * D4's conflict marker over a document nobody was arguing about.
 *
 * The cells within a row are encoded in the row's `text`, delimited by `|`,
 * which is the one place a second encoding was unavoidable — a row is the merge
 * unit and its cells travel together by definition. So the encoding is written
 * once, here, with an escape that round-trips, rather than in whichever
 * renderer needed it first.
 */

const DELIMITER = '|';

/** A table is not unbounded: past this a person wanted a database, not a table. */
export const MAX_TABLE_COLUMNS = 32;

/**
 * Cells to a row's stored text.
 *
 * `\` and `|` are escaped, in that order, because escaping the delimiter first
 * would then have its own backslash escaped and produce `\\|` — a literal
 * backslash followed by a delimiter, which is a different row.
 */
export function formatTableRow(cells: readonly string[]): string {
  return cells
    .slice(0, MAX_TABLE_COLUMNS)
    .map((cell) => cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'))
    .join(DELIMITER);
}

/** A row's stored text back to cells. Always at least one cell, never null. */
export function parseTableRow(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [''];

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\\' || next === DELIMITER) {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === DELIMITER) {
      cells.push(current);
      current = '';
      if (cells.length >= MAX_TABLE_COLUMNS) {
        // The overflow joins the last cell rather than being dropped: a row that
        // silently loses its tail is content gone with no notice, and this
        // encoding is the only thing standing between the text and the reader.
        current = text.slice(i + 1).replace(/\\([\\|])/g, '$1');
        break;
      }
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

/**
 * How wide the table is, taken from its widest row.
 *
 * Derived rather than stored on the `table` block for the same reason the list
 * ordinal is: a stored column count and a set of rows that merged independently
 * would disagree, and the reader would get a row with a missing column or a
 * column with no header.
 */
export function tableWidth(rows: Iterable<string>): number {
  let width = 0;
  for (const row of rows) width = Math.max(width, parseTableRow(row).length);
  return Math.max(1, Math.min(width, MAX_TABLE_COLUMNS));
}

/** A row padded to the table's width, so a short row renders as empty cells. */
export function tableCells(rowText: string, width: number): string[] {
  const cells = parseTableRow(rowText);
  while (cells.length < width) cells.push('');
  return cells.slice(0, width);
}

/** Replace one cell, returning the row's new text. Out-of-range extends the row. */
export function setTableCell(rowText: string, column: number, value: string): string {
  const index = Math.max(0, Math.min(Math.trunc(column), MAX_TABLE_COLUMNS - 1));
  const cells = parseTableRow(rowText);
  while (cells.length <= index) cells.push('');
  cells[index] = value;
  return formatTableRow(cells);
}
