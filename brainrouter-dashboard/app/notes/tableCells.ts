/**
 * ADR-029 E4 — a table row's cells, decoded for reading.
 *
 * A table is a `table` block whose children are `table-row` blocks, and a row's
 * cells are encoded in the row's own `text` with `|` as the delimiter. That
 * encoding is defined once, in core's `tableBlock.ts`, and this is a second
 * implementation of it — which is a BOUNDARY rather than an oversight:
 * `scripts/check-package-boundaries.mjs` allows the dashboard to depend on
 * hooks, sdk and types and not on core, so no import from this app can reach the
 * one true encoder. It is the same constraint that made `page.tsx` re-read E2's
 * inline marks instead of calling core's parser, and its header records the same
 * escape hatch: if this starts to matter the fix is core publishing a
 * browser-safe module, not this file growing.
 *
 * **It decodes and never encodes, and that asymmetry is what makes it safe.**
 * The dashboard is a reader — no gesture here writes a row — so there is no
 * second WRITER to disagree with core about how a `|` is escaped. The worst a
 * mistake here can do is draw a cell wrongly on one surface, which somebody can
 * see. It can never store a row the desktop would read back differently, which
 * nobody would.
 *
 * `notes-dashboard-renderers.test.ts` in the backend workspace pins this against
 * core's own `parseTableRow` over the escape cases, so the two cannot drift
 * quietly.
 */

/** Core's `MAX_TABLE_COLUMNS`. Past this a person wanted a database, not a table. */
export const MAX_TABLE_COLUMNS = 32;

/**
 * A row's stored text back to cells. Always at least one cell, never null.
 *
 * `\` and `|` are the two escaped characters, and the overflow past the column
 * bound joins the last cell rather than being dropped — a row that silently
 * loses its tail is content gone with no notice, and this decoding is the only
 * thing standing between the stored text and the reader.
 */
export function parseTableRow(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [""];

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\\" || next === "|") {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      if (cells.length >= MAX_TABLE_COLUMNS) {
        current = text.slice(i + 1).replace(/\\([\\|])/g, "$1");
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
 * Derived rather than read off the `table` block for the reason core gives: a
 * stored column count and a set of rows that merged independently would
 * disagree, and the reader would get a row with a missing column or a column
 * with no header.
 */
export function tableWidth(rows: Iterable<string>): number {
  let width = 0;
  for (const row of rows) width = Math.max(width, parseTableRow(row).length);
  return Math.max(1, Math.min(width, MAX_TABLE_COLUMNS));
}

/** A row padded to the table's width, so a short row renders as empty cells. */
export function tableCells(rowText: string, width: number): string[] {
  const cells = parseTableRow(rowText);
  while (cells.length < width) cells.push("");
  return cells.slice(0, width);
}
