/**
 * ADR-029 F3 — what "export" offers, and what it says afterwards.
 *
 * The file itself is written by core, so the desktop and the dashboard produce
 * the same bytes. What lives here is the two things a surface has to decide and
 * a writer cannot: which formats to OFFER for the thing being looked at, and the
 * sentence shown once the file has been saved.
 *
 * **The offer is narrow on purpose.** F1's bar is that nothing promises what it
 * does not do, so a page of paragraphs is not offered CSV: a spreadsheet of one
 * column called Title is not that page, and an entry that produces something
 * unrecognisable is worse than an entry that is absent.
 *
 * **The sentence names the omissions.** `document.ts` makes an export carry what
 * it could not hold; a surface that saved the file and said "Exported" would put
 * that honesty in the file and hide it from the person who has to decide whether
 * the backup is good enough.
 */

export type NoteExportFormatId = 'markdown' | 'csv';

/** What comes back from the host's `notes-export`. */
export interface NoteExportDto {
  ok?: boolean;
  error?: string;
  format?: NoteExportFormatId;
  filename?: string;
  contentType?: string;
  content?: string;
  count?: number;
  truncated?: boolean;
  omissions?: Array<{ kind: string; detail: string }>;
}

export interface ExportChoice {
  format: NoteExportFormatId;
  label: string;
}

/**
 * The formats offered for what is currently open.
 *
 * A database is both: the page IS the table, so Markdown writes its rows as a
 * grid and CSV writes the view. Everything else is Markdown alone.
 */
export function exportChoicesFor(isDatabase: boolean): ExportChoice[] {
  const markdown: ExportChoice = { format: 'markdown', label: 'Markdown (.md)' };
  return isDatabase ? [markdown, { format: 'csv', label: 'Spreadsheet (.csv)' }] : [markdown];
}

/** The line shown after a file is saved. Never just "Exported". */
export function exportNotice(written: NoteExportDto): string {
  const name = written.filename ?? 'the file';
  const count = written.count ?? 0;
  const unit = written.format === 'csv'
    ? (count === 1 ? '1 row' : `${count} rows`)
    : (count === 1 ? '1 block' : `${count} blocks`);
  const head = `Saved ${name} — ${unit}.`;
  const notes = written.omissions ?? [];
  if (notes.length === 0) return head;
  // The sentences themselves, not a count of them: "3 things were left out"
  // makes the person open the file to find out what, which is the work the
  // omission list exists to save.
  return `${head} ${notes.map((omission) => omission.detail).join(' ')}`;
}
