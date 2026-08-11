/**
 * ADR-029 F3 — a table's grid, and what an edit to it asks the store for.
 *
 * `tableBlock.ts` in core already owns the ENCODING — a row's cells in its own
 * `text`, delimited and escaped — and the column arithmetic. This file is the
 * layer above: it turns a table block plus the flat block list into a grid, and
 * turns a person's gesture into the list of writes that performs it.
 *
 * **A column edit is N writes and that is not a leak.** Every row holds its own
 * cells, so widening the table touches every row block — and each of those is an
 * ordinary block update, which means it merges per B1, queues on that row's own
 * outbox stream per B3, and is refused while another device holds that row's
 * lease per B2. The alternative (one JSON blob on the table) would make the same
 * gesture a single write that silently discarded anything anyone else had typed
 * anywhere in the table.
 *
 * **The header row is the table block's `checked` field.** That is a stamped
 * boolean every block already carries, so it merges through `sync/stamped.ts`
 * with no new field, no new merge rule and no migration. `mergeCompletion` ties
 * it toward TRUE, which is the right bias here for a reason worth stating: a
 * header that survives a concurrent toggle leaves the first row read as labels,
 * while losing it silently re-reads a row of labels as data.
 *
 * Pure. Nothing here reads a store or knows what a bridge is.
 */
import {
  emptyTableRow, insertTableColumn, MAX_TABLE_COLUMNS, removeTableColumn,
  setTableCell, tableCells, tableWidth,
} from '@kinqs/brainrouter-core/notes/editing';
import type { NoteBlockView } from './notesView.js';

export interface TableRowView {
  id: string;
  cells: string[];
  /** B2 — another device holds this row, so its cells are read-only WITH a name. */
  lockedBy: string | null;
}

export interface TableGrid {
  tableId: string;
  width: number;
  /** The first row, when the table is showing one as a header. Null otherwise. */
  header: TableRowView | null;
  /** Everything the header is not. Empty for a table nobody has started. */
  body: TableRowView[];
  /** Every row in document order, header first — what a column edit maps over. */
  rows: TableRowView[];
  hasHeader: boolean;
}

/** One write a gesture asks for: a block id and the text it should now hold. */
export interface TableCellWrite {
  id: string;
  text: string;
}

/**
 * The grid for one table block.
 *
 * Order comes from the flat list, which the host already emits in tree order —
 * re-sorting here would let the grid disagree with the document about which row
 * is first, and "which row is first" is exactly what the header toggle is about.
 */
export function tableGrid(table: NoteBlockView, blocks: readonly NoteBlockView[]): TableGrid {
  const rowBlocks = blocks.filter((block) => block.parentId === table.id && block.kind === 'table-row');
  const width = tableWidth(rowBlocks.map((row) => row.text));
  const rows: TableRowView[] = rowBlocks.map((row) => ({
    id: row.id,
    cells: tableCells(row.text, width),
    lockedBy: row.lockedBy,
  }));
  const hasHeader = table.checked && rows.length > 0;

  return {
    tableId: table.id,
    width,
    header: hasHeader ? rows[0]! : null,
    body: hasHeader ? rows.slice(1) : rows,
    rows,
    hasHeader,
  };
}

/** Whether the table can take another column — the cap is core's, not a second one. */
export function canAddColumn(grid: TableGrid): boolean {
  return grid.width < MAX_TABLE_COLUMNS;
}

/**
 * Whether a column can go.
 *
 * The last one cannot: a row with no cells has nowhere to hold the text that was
 * in it and renders as a strip that cannot be typed into. Deleting the TABLE is
 * the gesture for that, and it leaves a tombstone the trash can restore.
 */
export function canRemoveColumn(grid: TableGrid): boolean {
  return grid.width > 1;
}

export function addColumnWrites(grid: TableGrid, at: number): TableCellWrite[] {
  if (!canAddColumn(grid)) return [];
  const index = Math.max(0, Math.min(Math.trunc(at), grid.width));
  return grid.rows.map((row) => ({
    id: row.id,
    text: insertTableColumn(rowText(row), index),
  }));
}

export function removeColumnWrites(grid: TableGrid, at: number): TableCellWrite[] {
  if (!canRemoveColumn(grid)) return [];
  const index = Math.trunc(at);
  if (index < 0 || index >= grid.width) return [];
  return grid.rows.map((row) => ({
    id: row.id,
    text: removeTableColumn(rowText(row), index),
  }));
}

/** One cell edited, as the one write it is. */
export function setCellWrite(row: TableRowView, column: number, value: string): TableCellWrite {
  return { id: row.id, text: setTableCell(rowText(row), column, value) };
}

/** The text a new row starts with — as wide as the table already is. */
export function newRowText(grid: TableGrid): string {
  return emptyTableRow(grid.width);
}

/**
 * A column's name for the controls that act on it.
 *
 * From the header cell when there is one, because that is what the person called
 * it; from the position otherwise, because "remove column 2" is still
 * unambiguous while "remove column" is not.
 */
export function columnLabel(grid: TableGrid, index: number): string {
  const named = grid.header?.cells[index]?.trim();
  return named || `Column ${index + 1}`;
}

/** Whether a row's cells accept typing — B2's lease, read per row. */
export function rowIsEditable(row: TableRowView): boolean {
  return row.lockedBy === null;
}

/** What a table with no rows invites, rather than an empty box. */
export const EMPTY_TABLE_INVITATION = 'An empty table. Add the first row to start filling it in.';

export function headerActionLabel(hasHeader: boolean): string {
  return hasHeader ? 'Use the first row as data' : 'Use the first row as headings';
}

function rowText(row: TableRowView): string {
  // Rebuilt from the padded cells rather than kept beside them, so a short row
  // that was rendered as empty cells is widened by the same edit that touches
  // it — otherwise adding a column to a five-column table would leave a
  // two-column row two columns wide and one cell out of alignment.
  return row.cells.reduce((text, cell, index) => setTableCell(text, index, cell), '');
}
