/**
 * ADR-029 F3 — the table block, which used to be an empty line.
 *
 * A real grid over the model `tableBlock.ts` already had: the table is a block
 * and its ROWS are blocks, so every one of them merges on its own (B1), syncs on
 * its own ordered stream (B3) and is refused while another device holds it (B2).
 * This component is the surface over that and nothing else — the encoding, the
 * column arithmetic and the caps are core's, and what a gesture means is
 * the sibling `tableView` module.
 *
 * **A column edit writes every row, on purpose.** See `tableView.ts` for the
 * argument: one write per row is what buys per-row merging, and the "cheaper"
 * single-blob table would silently discard whatever anybody else had typed.
 *
 * The cells are plain inputs rather than the block editor. A cell is a value,
 * not a paragraph — it has no slash menu, no marks and no split — and putting a
 * contenteditable in one would offer gestures the row cannot honour, which is
 * the F1 defect written into a table.
 */
import React from 'react';
import { Icon } from './Icon.js';
import {
  addColumnWrites, canAddColumn, canRemoveColumn, columnLabel, EMPTY_TABLE_INVITATION,
  headerActionLabel, newRowText, removeColumnWrites, rowIsEditable, setCellWrite, tableGrid,
  type TableCellWrite, type TableGrid, type TableRowView,
} from './tableView.js';
import type { NoteBlockView } from './notesView.js';

export interface TableBlockOps {
  /** One row, inside the table. Its parent is the table, not the page. */
  addTableRow: (tableId: string, text: string, after?: string) => void;
  /** A heading row and one row to type in — the same seed `/table` uses. */
  startTable: (tableId: string) => void;
  /** A column edit, as the N row writes it actually is. */
  writeRows: (writes: readonly TableCellWrite[]) => void;
  setText: (id: string, text: string) => void;
  deleteBlock: (id: string) => void;
  /**
   * The header flag is the table block's own `checked` field — a stamped boolean
   * every block already carries, so it merges with no new field and no
   * migration. `toggleChecked` is the write for it.
   */
  toggleChecked: (id: string, checked: boolean) => void;
}

export function TableBlock({ table, blocks, ops }: {
  table: NoteBlockView;
  /** Every block on the device — the rows are found among them by parent. */
  blocks: readonly NoteBlockView[];
  ops: TableBlockOps;
}): React.ReactElement {
  const grid = tableGrid(table, blocks);
  const columns = Array.from({ length: grid.width }, (_, index) => index);

  if (grid.rows.length === 0) {
    return (
      <div className="notes-table is-empty">
        <span className="notes-table-note">{EMPTY_TABLE_INVITATION}</span>
        {/* The same seed `/table` uses, so a table converted from a paragraph
            and a table typed as a command are the same table. */}
        <button className="notes-table-btn" onClick={() => ops.startTable(table.id)}>
          <Icon name="plus" size={11} /> Start the table
        </button>
      </div>
    );
  }

  return (
    <div className="notes-table">
      <div className="notes-table-scroll">
        <table className="notes-grid">
          {grid.hasHeader && grid.header ? (
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className="notes-grid-head">
                    <Cell
                      row={grid.header!} column={column} grid={grid} ops={ops}
                      placeholder={`Column ${column + 1}`}
                    />
                    <ColumnTools grid={grid} column={column} ops={ops} />
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {grid.body.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td key={column} className="notes-grid-cell">
                    <Cell row={row} column={column} grid={grid} ops={ops} placeholder="" />
                    {/* The column tools live on the header when there is one, and
                        on the first body row when there is not — otherwise a
                        header-less table has no way to add a column at all. */}
                    {!grid.hasHeader && row.id === grid.body[0]?.id ? (
                      <ColumnTools grid={grid} column={column} ops={ops} />
                    ) : null}
                  </td>
                ))}
                <td className="notes-grid-rowtools">
                  <button
                    className="notes-table-icon" title="Remove this row" aria-label="Remove this row"
                    onClick={() => ops.deleteBlock(row.id)}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* B2's attribution, per row rather than per table: a lock on one row
          must not read as the whole table being unavailable. */}
      {grid.rows.filter((row) => row.lockedBy).map((row) => (
        <div key={row.id} className="notes-locked">{row.lockedBy}</div>
      ))}

      <div className="notes-table-tools">
        <button
          className="notes-table-btn"
          onClick={() => ops.addTableRow(table.id, newRowText(grid), grid.rows[grid.rows.length - 1]?.id)}
        >
          <Icon name="plus" size={11} /> Row
        </button>
        <button
          className="notes-table-btn"
          disabled={!canAddColumn(grid)}
          title={canAddColumn(grid) ? undefined : 'A table this wide wanted to be a database.'}
          onClick={() => ops.writeRows(addColumnWrites(grid, grid.width))}
        >
          <Icon name="plus" size={11} /> Column
        </button>
        <button className="notes-table-btn" onClick={() => ops.toggleChecked(table.id, !grid.hasHeader)}>
          {headerActionLabel(grid.hasHeader)}
        </button>
      </div>
    </div>
  );
}

/**
 * One cell.
 *
 * It writes on blur and on Enter rather than per keystroke: every keystroke
 * would be a stamped edit in the outbox (D2), and the row's text is rebuilt
 * whole each time, so a fast typist would queue one full-row write per
 * character.
 */
function Cell({ row, column, grid, ops, placeholder }: {
  row: TableRowView;
  column: number;
  grid: TableGrid;
  ops: TableBlockOps;
  placeholder: string;
}): React.ReactElement {
  const stored = row.cells[column] ?? '';
  const [draft, setDraft] = React.useState(stored);
  const editable = rowIsEditable(row);

  // The stored value wins whenever it changes underneath — a merge, or another
  // device's edit arriving on a sync tick. Without this the cell would go on
  // showing what was typed here over what the store actually holds.
  React.useEffect(() => { setDraft(stored); }, [stored]);

  const commit = (): void => {
    if (!editable || draft === stored) return;
    const write = setCellWrite(row, column, draft);
    ops.setText(write.id, write.text);
  };

  return (
    <input
      className="notes-grid-input"
      value={draft}
      readOnly={!editable}
      placeholder={placeholder}
      aria-label={`${columnLabel(grid, column)} cell`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); }
        if (event.key === 'Escape') setDraft(stored);
      }}
    />
  );
}

function ColumnTools({ grid, column, ops }: {
  grid: TableGrid;
  column: number;
  ops: TableBlockOps;
}): React.ReactElement {
  return (
    <span className="notes-grid-coltools">
      <button
        className="notes-table-icon"
        title={`Add a column after ${columnLabel(grid, column)}`}
        aria-label={`Add a column after ${columnLabel(grid, column)}`}
        disabled={!canAddColumn(grid)}
        onClick={() => ops.writeRows(addColumnWrites(grid, column + 1))}
      >
        <Icon name="plus" size={10} />
      </button>
      <button
        className="notes-table-icon"
        title={`Remove ${columnLabel(grid, column)}`}
        aria-label={`Remove ${columnLabel(grid, column)}`}
        disabled={!canRemoveColumn(grid)}
        onClick={() => ops.writeRows(removeColumnWrites(grid, column))}
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  );
}
