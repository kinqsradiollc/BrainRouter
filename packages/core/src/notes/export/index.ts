/**
 * ADR-029 F3 — "can I leave", answered by one function.
 *
 * The two writers are separate files because Markdown and CSV disagree about
 * everything except the walk; this is the door, so a caller asks for a FORMAT
 * and does not have to know that a page goes one way and a database the other.
 * A surface that chose the writer itself would eventually offer CSV on a page,
 * which is the F1 defect — an offer the product cannot honour.
 */
import { isDatabaseBlock } from '../database.js';
import { isLiveBlock, type NoteBlock } from '../block.js';
import { exportDatabaseCsv } from './csv.js';
import { exportPageMarkdown } from './markdown.js';
import type { NoteExport, NoteExportFormat, NoteExportOptions } from './document.js';

export * from './document.js';
export * from './walk.js';
export { exportPageMarkdown } from './markdown.js';
export { exportDatabaseCsv, csvField } from './csv.js';

/**
 * Which formats this block can actually be written as.
 *
 * Asked by a menu, so a page never offers CSV: F1's rule is that nothing
 * promises what it does not do, and "Export as CSV" on a page of paragraphs has
 * no honest answer — a table of one column called Title is not the page.
 */
export function exportFormatsFor(block: NoteBlock | undefined): NoteExportFormat[] {
  if (!block || !isLiveBlock(block)) return [];
  return isDatabaseBlock(block) ? ['markdown', 'csv'] : ['markdown'];
}

/** One block, in one format, or `null` when this block cannot be written that way. */
export function exportNote(
  blocks: Iterable<NoteBlock>,
  blockId: string,
  format: NoteExportFormat,
  opts: NoteExportOptions = {},
): NoteExport | null {
  const all = [...blocks];
  const block = all.find((candidate) => candidate.id === blockId && isLiveBlock(candidate));
  if (!block) return null;
  if (format === 'csv') {
    // A database only. Refused rather than approximated, for the reason above.
    return isDatabaseBlock(block) ? exportDatabaseCsv(all, blockId, opts) : null;
  }
  return exportPageMarkdown(all, blockId, opts);
}
