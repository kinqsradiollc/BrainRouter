/**
 * ADR-030 D5 — the second landing place: *"a note — an imported document becomes
 * a page of blocks, addressable at `brainrouter://notes/block/…` (ADR-029 A1)."*
 *
 * D5 names three places a parsed document can land: the turn, memory, and a
 * note. The first two shipped; this one did not, and nothing in the repository
 * admitted it — which is the shape of omission ADR-030 §1.1 is written against.
 *
 * **What this does NOT do is as load-bearing as what it does.** It does not
 * parse, hash, classify or store anything: it reads an artifact that
 * `attachment/document/` has already produced, and every block it makes goes
 * through `notesCreateBlock` — the same writer a person's typing goes through,
 * so the lease, the clock and the outbox entry are the ones an edit gets. A
 * second write path would be the one edit in the product that a lock could not
 * refuse and a sync could not order, arriving in bulk.
 *
 * **The shape of the page.** One page block titled after the file, one
 * provenance paragraph, then the artifact's parts in order:
 *
 *  - A part that knows its page number gets a heading, so the note has the
 *    document's own structure and someone reading it can find page 7.
 *  - A part's text is split on blank lines into paragraphs, because one block
 *    holding forty pages of prose is a block nobody can edit, fold, cite or
 *    comment on — and being able to do those things is the whole reason D5 lists
 *    a note as a landing place rather than calling the artifact enough.
 *  - Every block is capped well under the store's own text limit, so an import
 *    cannot mint a block a later push would refuse — or one nobody can edit.
 *
 * **The document is content, not instruction.** Its text becomes note text,
 * which is exactly what happens when a person pastes it — and a note reaching an
 * agent goes through C4's fence like every other note. Nothing here interprets
 * what the document says.
 */
import type { DocumentArtifact, DocumentPart } from '../attachment/document/artifact.js';
import { documentOutlineUri } from '../attachment/document/artifact.js';
import { createBlock as notesCreateBlock, createPage as notesCreatePage } from './noteStore.js';

/**
 * The most blocks one import may mint.
 *
 * A cap rather than a rate: the artifact is already bounded, but the SPLIT is
 * not — a document of ten thousand short lines would become ten thousand
 * blocks, and a page that size is one nobody can open on either surface. What
 * is refused is counted and said, never dropped in silence.
 */
export const MAX_IMPORTED_BLOCKS = 400;

/**
 * The most text one imported block carries.
 *
 * Far below the store's own 100,000-character ceiling, and on purpose: a
 * paragraph that long is a block nobody can edit, fold or comment on, which
 * would defeat the reason a note is a landing place at all. Real documents
 * never reach it — the parts arrive pre-split — so this only bites on a file
 * engineered to have none.
 */
const MAX_IMPORTED_BLOCK_TEXT = 8_000;

/** Below this a paragraph is a fragment; splitting further stops helping. */
const MIN_PARAGRAPH = 2;

export interface ImportDocumentInput {
  /** The parsed artifact. Read by the caller, so this function touches no disk. */
  artifact: DocumentArtifact;
  /** Which page the imported page goes inside. `null`/absent is the top level. */
  parentId?: string | null;
  /** Whose notes. `undefined` is the one-store-per-install case (ADR-028 D9). */
  userId?: string | undefined;
  nowMs?: number;
  maxBlocks?: number;
}

export interface ImportedDocument {
  /** The page block. This is the `brainrouter://notes/block/…` D5 promises. */
  pageId: string;
  /** Every block minted, the page included. */
  blocks: number;
  /** Blocks the cap refused. Zero is the normal case. */
  omitted: number;
  /** One sentence for a person or an agent to repeat. Assembled from counts. */
  summary: string;
}

/** The document's own name, reduced to one line that can be a page title. */
function pageTitle(artifact: DocumentArtifact): string {
  const name = (artifact.name ?? '').split('\n')[0]?.trim() ?? '';
  return (name || 'Imported document').slice(0, 200);
}

/**
 * A part's heading, when the part knows where it came from.
 *
 * Built from the part's NUMBERS, never from its text: a heading taken from the
 * document's first line would be the one place in this file where content
 * decided structure.
 */
function partHeading(part: DocumentPart): string | null {
  if (typeof part.page !== 'number') return null;
  const kind = part.kind && part.kind !== 'text' ? ` — ${part.kind}` : '';
  return `Page ${part.page}${kind}`;
}

/**
 * A part's text as paragraphs.
 *
 * Blank lines, because that is what a blank line means in every text format the
 * parser emits. A run longer than one block is cut at the store's own limit
 * rather than at a word, because the alternative is a block the store would
 * refuse — and an import that half-succeeds is worse than one that says it cut.
 */
function paragraphsOf(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\n[ \t]*\n/)) {
    const trimmed = chunk.trim();
    if (trimmed.length < MIN_PARAGRAPH) continue;
    for (let at = 0; at < trimmed.length; at += MAX_IMPORTED_BLOCK_TEXT) {
      out.push(trimmed.slice(at, at + MAX_IMPORTED_BLOCK_TEXT));
    }
  }
  return out;
}

/**
 * Turn a parsed document into a page of blocks.
 *
 * Returns the page's id, which is the address D5 asks for: everything else in
 * the workspace can now cite this document by citing a note.
 */
export function importDocumentAsNote(input: ImportDocumentInput): ImportedDocument {
  const { artifact } = input;
  const nowMs = input.nowMs ?? Date.now();
  const userId = input.userId;
  const parentId = input.parentId ?? null;
  const cap = Math.max(1, Math.min(input.maxBlocks ?? MAX_IMPORTED_BLOCKS, MAX_IMPORTED_BLOCKS));

  const page = notesCreatePage(userId, { title: pageTitle(artifact), parentId }, nowMs);
  let minted = 1;
  let clock = nowMs;
  let omitted = 0;

  const add = (fields: { kind?: 'heading' | 'paragraph'; text: string; level?: number }): boolean => {
    if (minted >= cap) { omitted += 1; return false; }
    clock += 1;
    notesCreateBlock(
      userId,
      {
        kind: fields.kind ?? 'paragraph',
        text: fields.text,
        parentId: page.id,
        ...(fields.level === undefined ? {} : { level: fields.level }),
      },
      clock,
    );
    minted += 1;
    return true;
  };

  // Provenance first, and it is a REFERENCE rather than a copy: A2's rule, so
  // there is one document and one edge to it, written into the content that
  // cites it. `notice` is our own sentence, assembled from counts by the parser
  // — the one line here that did not come out of the file.
  const provenance = [documentOutlineUri(artifact.attachmentId), artifact.notice]
    .filter((line) => line.trim().length > 0)
    .join('\n\n');
  add({ text: provenance.slice(0, MAX_IMPORTED_BLOCK_TEXT) });

  for (const part of artifact.parts) {
    const heading = partHeading(part);
    if (heading && !add({ kind: 'heading', text: heading, level: 2 })) break;
    let stopped = false;
    for (const paragraph of paragraphsOf(part.text)) {
      if (!add({ text: paragraph })) { stopped = true; break; }
    }
    if (stopped) break;
  }

  // Everything the artifact ALREADY knew it was missing is said here too. A page
  // that looks complete is worse than one that is visibly partial — the same
  // rule the Markdown export follows, applied to the other direction of travel.
  const notes: string[] = [];
  if (omitted > 0) notes.push(`${omitted} more block${omitted === 1 ? '' : 's'} did not fit and were not imported`);
  if (artifact.partsOmitted > 0) notes.push(`${artifact.partsOmitted} parts of the document were not stored`);
  if (artifact.parseTruncated) notes.push('the document was longer than the parser reads');

  const blocksWord = `${minted} block${minted === 1 ? '' : 's'}`;
  const summary = notes.length === 0
    ? `New page from the document — ${blocksWord}.`
    : `New page from the document — ${blocksWord}. What it does not carry: ${notes.join('; ')}.`;

  return { pageId: page.id, blocks: minted, omitted, summary };
}
