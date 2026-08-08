/**
 * ADR-029 F3 — a database view as CSV, escaped for the two readers it has.
 *
 * The rows and columns are the VIEW's, not the table's: what a person means by
 * "export this" is the thing they are looking at, filtered and sorted and in the
 * order they arranged. Exporting the underlying rows instead would produce a
 * file that disagrees with the screen and give no clue why.
 *
 * **Two escapes, for two different readers, and they are not the same problem.**
 *
 *  - RFC 4180 is for the PARSER: a field containing a comma, a quote or a line
 *    break is wrapped in quotes and its own quotes are doubled. Get this wrong
 *    and a cell with a comma in it becomes two columns.
 *  - The leading-character guard is for the SPREADSHEET: Excel, Numbers and
 *    Sheets read a field beginning `=`, `+`, `-`, `@`, TAB or CR as a FORMULA,
 *    so a note somebody synced to you saying `=cmd|'/c calc'!A1` runs on the
 *    machine of whoever opens the export. A correctly quoted field is still a
 *    formula to those readers, which is why quoting alone is not the answer: the
 *    value is prefixed with an apostrophe so it opens as the text it was.
 *
 * The second one is the reason this file does not simply hand cells to a generic
 * CSV writer. The value being exported is user text that arrived over sync from
 * another device, and the person opening it is not the person who wrote it.
 */
import { type NoteBlock } from '../block.js';
import { projectDatabase } from '../databaseProjection.js';
import {
  dedupeOmissions, exportFilename, MAX_EXPORT_BLOCKS, MAX_EXPORT_CHARS,
  type NoteExport, type NoteExportOmission, type NoteExportOptions,
} from './document.js';

/** The characters a spreadsheet reads as "this field is a formula". */
const FORMULA_LEADS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * One field, safe for a parser AND for a spreadsheet.
 *
 * Exported because the rule belongs to the format rather than to this caller: a
 * second writer that escaped only for the parser would be the drift that lets
 * the injection back in.
 */
export function csvField(raw: string): string {
  const text = raw.slice(0, MAX_EXPORT_CHARS);
  // The apostrophe goes on BEFORE the quoting, so it is inside the quoted field
  // where the spreadsheet reads it, rather than outside where the parser would
  // treat it as stray text.
  const guarded = text.length > 0 && FORMULA_LEADS.has(text[0]!) ? `'${text}` : text;
  return `"${guarded.split('"').join('""')}"`;
}

/** A whole row, already escaped. CRLF because that is what RFC 4180 says. */
function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * A database view as CSV.
 *
 * Returns `null` when the block is not a database, matching `projectDatabase`:
 * writing an empty file for a paragraph would tell the person their database is
 * empty rather than that they exported the wrong block.
 */
export function exportDatabaseCsv(
  blocks: Iterable<NoteBlock>,
  databaseId: string,
  opts: NoteExportOptions = {},
): NoteExport | null {
  const projection = projectDatabase(blocks, databaseId, opts.viewId, {
    ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    ...(opts.deviceId === undefined ? {} : { deviceId: opts.deviceId }),
    ...(opts.canSee === undefined ? {} : { canSee: opts.canSee }),
  });
  if (!projection) return null;

  const limit = Math.max(1, Math.min(opts.maxBlocks ?? MAX_EXPORT_BLOCKS, MAX_EXPORT_BLOCKS));
  const maxChars = Math.max(1, Math.min(opts.maxChars ?? MAX_EXPORT_CHARS, MAX_EXPORT_CHARS));

  const omissions: NoteExportOmission[] = [];
  for (const rule of projection.skipped) {
    omissions.push({
      kind: 'view_rule',
      // The view's own sentence, so the file and the screen say the same thing
      // about a rule neither of them could apply.
      detail: rule.detail,
    });
  }

  const header = ['Title', ...projection.columns.map((column) => column.name)];
  const lines: string[] = [csvRow(header)];
  let chars = lines[0]!.length + 2;
  let count = 0;
  let truncated = false;

  for (const row of projection.rows) {
    if (count >= limit) { truncated = true; break; }
    // The DISPLAY string, which is what the cell shows: a formula's result, a
    // rollup's number with the clause about what it does not include, and — for
    // a cell that could not be computed — the sentence saying why. A file that
    // wrote a blank there would be the "wrong rather than absent" outcome F2
    // refuses, moved into the export.
    const line = csvRow([row.title, ...row.cells.map((cell) => cell.display)]);
    if (chars + line.length + 2 > maxChars) { truncated = true; break; }
    lines.push(line);
    chars += line.length + 2;
    count += 1;
    if (row.cells.some((cell) => cell.error)) {
      omissions.push({
        kind: 'unsupported',
        detail: 'A computed column could not be worked out for every row; those cells carry the reason instead of a value.',
      });
    }
    if (row.cells.some((cell) => cell.unsupported)) {
      omissions.push({
        kind: 'unsupported',
        detail: 'A column from a newer version of this app was written out as it was stored.',
      });
    }
  }

  if (truncated) {
    omissions.push({
      kind: 'bounded',
      detail: `This view has more rows than an export carries, so it stops after ${count}.`,
    });
  }
  if (projection.filteredOut > 0) {
    omissions.push({
      kind: 'view_rule',
      detail: `${projection.filteredOut} rows are filtered out of this view and are not in the file.`,
    });
  }

  return {
    format: 'csv',
    filename: exportFilename(projection.title || 'database', 'csv'),
    contentType: 'text/csv; charset=utf-8',
    // CRLF, and a trailing one: RFC 4180's line ending, and the one every
    // spreadsheet agrees about.
    content: `${lines.join('\r\n')}\r\n`,
    count,
    truncated,
    omissions: dedupeOmissions(omissions),
  };
}
