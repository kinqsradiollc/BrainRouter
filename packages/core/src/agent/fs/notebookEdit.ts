/**
 * Pure Jupyter-notebook (.ipynb) cell editor — the logic behind the
 * `notebook_edit` tool, kept separate from the Agent so it unit-tests directly
 * (mirrors applyPatch.ts). JSON string in → JSON string out; all notebook
 * metadata (nbformat, kernelspec, unrelated cells) is preserved.
 */

export type NotebookCellType = 'code' | 'markdown';

export interface NotebookEditOptions {
  editMode: 'replace' | 'insert' | 'delete';
  /** 0-based cell index. Required for replace/delete; the insert position for insert. */
  cellIndex?: number;
  /** Required for insert; on replace, changes the cell's type when provided. */
  cellType?: NotebookCellType;
  /** New cell text; ignored for delete. */
  source?: string;
}

/** Jupyter stores a cell's source as an array of lines, each keeping its trailing "\n". */
function toLines(s: string): string[] {
  if (s.length === 0) return [];
  return s.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
}

function makeCell(type: NotebookCellType, source: string): Record<string, unknown> {
  return type === 'markdown'
    ? { cell_type: 'markdown', metadata: {}, source: toLines(source) }
    : { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: toLines(source) };
}

export function applyNotebookEdit(content: string, opts: NotebookEditOptions): { content: string; cells: number } {
  let nb: { cells?: unknown[] } & Record<string, unknown>;
  try {
    nb = JSON.parse(content);
  } catch {
    throw new Error('Notebook is not valid JSON (.ipynb).');
  }
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Notebook has no "cells" array.');
  const cells = nb.cells as Array<Record<string, unknown>>;
  const idx = opts.cellIndex;
  const inRange = typeof idx === 'number' && Number.isFinite(idx);
  const source = opts.source ?? '';

  if (opts.editMode === 'insert') {
    const at = inRange ? Math.max(0, Math.min(cells.length, idx as number)) : cells.length;
    cells.splice(at, 0, makeCell(opts.cellType ?? 'code', source));
  } else {
    if (!inRange || (idx as number) < 0 || (idx as number) >= cells.length) {
      throw new Error(`cell_index ${String(idx)} out of range (0..${Math.max(0, cells.length - 1)}).`);
    }
    const i = idx as number;
    if (opts.editMode === 'delete') {
      cells.splice(i, 1);
    } else {
      const cell = cells[i];
      cell.source = toLines(source);
      if (opts.cellType) {
        cell.cell_type = opts.cellType;
        if (opts.cellType === 'code' && !Array.isArray(cell.outputs)) {
          cell.outputs = [];
          cell.execution_count = null;
        }
      }
    }
  }
  return { content: `${JSON.stringify(nb, null, 1)}\n`, cells: cells.length };
}
