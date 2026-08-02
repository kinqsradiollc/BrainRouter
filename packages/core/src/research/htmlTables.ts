/**
 * ADR-027 D10 (P7-2) — tables must survive HTML→markdown conversion.
 *
 * A page read becomes a stored artifact the agent cites later. Most converters
 * flatten a table into a run of words, which is the single most damaging thing
 * they can do to a reference page: a specification's parameter table or a
 * pricing grid becomes a sentence where every cell has lost the row and column
 * that gave it meaning. The agent then cites it confidently, and the error is
 * invisible because the prose still reads fluently.
 *
 * So conversion here is deliberately conservative:
 *
 *  - A table that cannot be represented as a rectangle is NOT flattened. It is
 *    reported as unconvertible, because a wrong table is worse than an absent
 *    one — the reader cannot tell the wrong one is wrong.
 *  - Cell text is escaped so a literal `|` cannot forge a column boundary.
 *  - Relative URLs are absolutized against the page, since an artifact read
 *    weeks later has no way to resolve `/docs/x`.
 */

export interface TableCell {
  text: string;
  /** Column span, >= 1. */
  colSpan: number;
  /** Row span, >= 1. */
  rowSpan: number;
}

export interface ParsedTable {
  /** Header row, when the source marked one. */
  head: readonly TableCell[] | null;
  rows: readonly (readonly TableCell[])[];
}

export type TableConversion =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

/**
 * Escape a cell for a markdown table.
 *
 * A raw `|` inside a cell would create a column that does not exist, silently
 * shifting every value after it into the wrong header. Newlines collapse for
 * the same reason — a cell containing one would end the row early.
 */
export function escapeCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Absolutize a URL found in page content.
 *
 * An artifact is read long after the tab is gone, so a relative href is not
 * merely inconvenient — it is unresolvable. A URL that cannot be resolved is
 * returned unchanged rather than guessed at.
 */
export function absolutizeUrl(href: string, pageUrl: string): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Convert a parsed table to markdown, or explain why it cannot be.
 *
 * The rectangle requirement is the important part. Markdown tables have no
 * concept of a spanning cell, so a table using them cannot be represented
 * without inventing content — and inventing content in a reference the agent
 * will cite is exactly the failure this module exists to prevent.
 */
export function tableToMarkdown(table: ParsedTable): TableConversion {
  const allRows = [...(table.head ? [table.head] : []), ...table.rows];
  if (allRows.length === 0) return { ok: false, reason: 'the table has no rows' };

  const spanning = allRows.some((row) => row.some((c) => c.colSpan > 1 || c.rowSpan > 1));
  if (spanning) {
    return {
      ok: false,
      reason:
        'the table uses merged cells, which markdown cannot represent; ' +
        'flattening it would move values under the wrong headers',
    };
  }

  const widths = new Set(allRows.map((row) => row.length));
  if (widths.size > 1) {
    return {
      ok: false,
      reason: `the table is ragged (row widths ${[...widths].sort((a, b) => a - b).join(', ')}); ` +
        'padding it would invent cells that are not in the source',
    };
  }

  const width = allRows[0]!.length;
  if (width === 0) return { ok: false, reason: 'the table has no columns' };

  const header = table.head ?? allRows[0]!.map((_, i) => ({ text: `Column ${i + 1}`, colSpan: 1, rowSpan: 1 }));
  const body = table.head ? table.rows : table.rows;

  const line = (cells: readonly TableCell[]): string =>
    `| ${cells.map((c) => escapeCell(c.text)).join(' | ')} |`;

  const out = [
    line(header),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ];
  return { ok: true, markdown: out.join('\n') };
}

/**
 * The note left in an artifact where a table could not be converted.
 *
 * Silence would be worse: the reader sees prose with a gap and assumes nothing
 * was there. This states that content EXISTS and was not rendered, which is the
 * difference between a known gap and an invisible one.
 */
export function unconvertibleTableNote(reason: string, sourceUrl?: string): string {
  const where = sourceUrl ? ` See ${sourceUrl}` : '';
  return `> **Table omitted** — ${reason}.${where}`;
}
