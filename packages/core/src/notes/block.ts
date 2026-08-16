/**
 * ADR-029 B1 + B4 — the block, and the fact that a page is one too.
 *
 * **B1: the merge granularity IS the block.** ADR-028 D4 resolves conflicts per
 * field; here it resolves per block, so two people editing different paragraphs
 * of one page never conflict. Document-level storage would make every
 * concurrent edit a conflict, and D4's conflict preservation would fire
 * constantly until people stopped trusting it.
 *
 * **B4: a page is a block that has children.** Not a separate type — a separate
 * page type would need its own permissions, its own sync path and its own
 * conflict rules, and the first feature request ("can a page be embedded in a
 * page") would need them reconciled anyway. Nesting, sub-pages and a sidebar
 * tree are all one recursion over `parentId`.
 *
 * Every mutable field is `Stamped`, because D4 merges per field: two devices
 * changing a block's text and its checkbox are not in conflict, and a
 * whole-record stamp would make them so.
 *
 * **E4's block row lives here as kinds, not as tables.** A numbered item, a
 * toggle, a callout, an image and a table row are all one record with a
 * different `kind`, so every one of them inherits B1's merge granularity, B2's
 * lease and B3's outbox without a second write path. The two things a new kind
 * is allowed to add are a stamped field and a rule in `blockMerge.ts`.
 *
 * **What is deliberately NOT here: a numbered item's number.** It is computed
 * from tree position (`listNumbering.ts`). A stored ordinal goes wrong the
 * moment a sibling is deleted on another device — and repairing it would need
 * its own merge rule, on a value no one typed.
 */
import { hlcAfter, type Hlc } from '../sync/hybridClock.js';
import type { ConflictRecord, Stamped } from '../sync/stamped.js';
import { formatWorkspaceRef, type WorkspaceRef } from '../workspace/references/ref.js';
import type { NoteComment } from './comment.js';
import type { NotePropertyDef, NotePropertyValue } from './properties.js';
import type { NoteDatabaseView } from './databaseView.js';

/** The mode segment every note reference carries. */
export const NOTES_MODE = 'notes';
/** The kind segment. One kind, because B4 refuses a second one for pages. */
export const NOTE_BLOCK_KIND = 'block';

export type NoteBlockKind =
  | 'page'
  | 'heading'
  | 'paragraph'
  | 'bullet'
  /** Its number is a function of tree position, never a stored field. */
  | 'numbered'
  | 'todo'
  /** Children are hidden while `collapsed`; otherwise an ordinary parent. */
  | 'toggle'
  | 'quote'
  /** A framed aside. `icon` is its glyph, `text` its body. */
  | 'callout'
  | 'code'
  /** `text` is the image's URL or attachment reference (D3). */
  | 'image'
  /** `text` is the URL; the title and description are resolved, never stored. */
  | 'bookmark'
  /** A container whose children are its rows. */
  | 'table'
  /** `text` is the row's cells, encoded by `tableBlock.ts`. */
  | 'table-row'
  /**
   * E3 — a view over the pages beneath it. `text` is its title, `schema` its
   * property definitions, `views` its projections; its CHILDREN are its rows,
   * because a row is a page and not a record that links to one.
   */
  | 'database'
  /** Text is a single workspace reference, rendered live (A3). */
  | 'embed'
  /**
   * F3 — one block, many places, one truth. `text` is the SOURCE block's URI.
   *
   * A separate kind from `embed` because they are different gestures with
   * different rules: an embed shows another mode's record and is read-only where
   * it sits, while a synced block IS another block of this document and editing
   * it edits the original. Folding them together would make one of the two
   * silently do the other's thing — see `syncedBlock.ts`.
   */
  | 'synced'
  | 'divider';

export const NOTE_BLOCK_KINDS: readonly NoteBlockKind[] = [
  'page', 'heading', 'paragraph', 'bullet', 'numbered', 'todo', 'toggle', 'quote',
  'callout', 'code', 'image', 'bookmark', 'table', 'table-row', 'embed', 'synced', 'divider',
  'database',
];

/**
 * Kinds that continue themselves when Enter splits them.
 *
 * A list is the one shape where the next line is almost always the same line
 * again; a heading's next line almost never is. Splitting a heading into two
 * headings is the single most annoying thing a naive editor does.
 */
export const CONTINUING_KINDS: readonly NoteBlockKind[] = ['bullet', 'numbered', 'todo', 'quote'];

/** The kinds an input rule or a Backspace may turn back into a paragraph. */
export const STYLED_TEXT_KINDS: readonly NoteBlockKind[] = [
  'heading', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout', 'code',
];

/**
 * Kinds whose `text` is prose a person wrote, rather than an address.
 *
 * The distinction is what stops Backspace appending a paragraph onto an image
 * block's URL. `isTextlessKind` cannot answer it: an image HAS text, and that
 * text is a location, so treating it as somewhere to merge a sentence into
 * silently breaks the image and loses the sentence in one keystroke.
 */
const PROSE = new Set<NoteBlockKind>([
  'heading', 'paragraph', 'bullet', 'numbered', 'todo', 'toggle',
  'quote', 'callout', 'code', 'table-row',
]);

export function holdsProse(kind: NoteBlockKind): boolean {
  return PROSE.has(kind);
}

/** E4 offers 1–3; the field carries 1–6 because imported content has them. */
export const MAX_HEADING_LEVEL = 6;

export interface NoteBlock {
  id: string;
  /** `null` for a top-level block. A page is just one whose children point at it. */
  parentId: Stamped<string | null>;
  /** Sibling order — see `rank.ts` for why it is a string. */
  rank: Stamped<string>;
  kind: Stamped<NoteBlockKind>;
  /**
   * The block's content, and the ONLY place its references live (A2). An embed
   * block's text is the reference itself, so extraction has one path rather
   * than one per block kind — and a link typed inline in a paragraph is as real
   * a reference as one someone inserted deliberately.
   */
  text: Stamped<string>;
  /** For `todo`. */
  checked?: Stamped<boolean>;
  /** For `heading`, 1–6. */
  level?: Stamped<number>;
  /** For `code` — which highlighter the reader should get. */
  language?: Stamped<string>;
  /** For `toggle` — whether its children are folded away. */
  collapsed?: Stamped<boolean>;
  /**
   * The glyph in front: a page's icon, a callout's emoji.
   *
   * One field for both because it is the same decision rendered in two places,
   * and two fields would need a rule for which one a callout inside a page
   * uses.
   */
  icon?: Stamped<string>;
  /** A page's cover image, as a URL or an attachment reference (D3). */
  cover?: Stamped<string>;
  /** Pinned into the sidebar's favourites. */
  favourite?: Stamped<boolean>;
  /**
   * E3 — this block's property VALUES, when it is a row of a database.
   *
   * Keyed by property id and stamped PER KEY, which is D4's per-field rule taken
   * one level down: two devices editing two different properties of one row are
   * not in conflict, exactly as two people editing two paragraphs of one page
   * are not (B1). One `Stamped<Record<…>>` for the whole map would have made
   * every cell edit a whole-record write, so setting a status on a phone would
   * silently discard a due date typed on a laptop a second earlier.
   *
   * A concurrent edit to ONE property is last-writer-wins with no marker — see
   * `mergeProps` in `blockMerge.ts` for the two reasons.
   *
   * It lives on the ROW rather than in a database's own table because E3's
   * decision is that a row IS a page: giving values their own record would give
   * rows their own id, their own sync path and their own merge rules, which is
   * the second store E3 exists to refuse.
   */
  props?: Record<string, Stamped<NotePropertyValue>>;
  /**
   * E3 — a database block's property definitions.
   *
   * Separate from `views` rather than one `Stamped<{schema, views}>`, because
   * adding a property and renaming a view are different edits and a single field
   * would make one silently discard the other.
   */
  schema?: Stamped<readonly NotePropertyDef[]>;
  /** E3 — a database block's stored projections: table, board, list, calendar, gallery. */
  views?: Stamped<readonly NoteDatabaseView[]>;
  /**
   * F3 — this page is a TEMPLATE: something to start from, not something to read.
   *
   * A stamped boolean on the page rather than a template type, because B4/E3
   * already settled the shape — a template is a page, so a separate type would
   * need its own permissions, its own sync path and its own conflict rules, and
   * the first question ("can a template contain a database") would need them
   * reconciled anyway. Marking is the entire difference, and it merges
   * last-writer-wins like every other flag on a page.
   */
  template?: Stamped<boolean>;
  /**
   * F3 — the comments on this block, resolved and unresolved.
   *
   * Keyed by comment id and stamped PER FIELD inside each entry, which is D4's
   * rule taken one level down exactly as `props` takes it. Living on the block
   * rather than as child blocks is C5's requirement, not a storage convenience:
   * `deleteBlock` takes the subtree, so a comment stored as a child would be
   * deleted along with the block it is about — and C5's rule is that deleting a
   * target never deletes the link.
   *
   * A tombstoned block keeps its comments, which is what makes "a comment on a
   * deleted block must not vanish silently" true of the record rather than only
   * of the renderer. See `comment.ts`.
   */
  comments?: Record<string, NoteComment>;
  /**
   * F3 — when this block was made, and by which device.
   *
   * Not `Stamped`, for the reason `deletedAt` is not: the value IS the stamp,
   * and there is no payload two devices could disagree about. A creation happens
   * once, on one device, so the merge takes the EARLIEST claim (`mergeCreation`)
   * — a value that only ever moves backwards toward the truth and can never be
   * pushed forward by a later edit.
   *
   * It is a stored field rather than a derivation because every derivation is a
   * lie the moment the block is touched. The earliest surviving stamp is the
   * obvious one, and moving a block re-stamps `parentId` and `rank` while
   * editing it re-stamps `text` — so a page created in June would report itself
   * as created in August, in a column labelled "Created". F3's rule about
   * metadata is that it is not metadata if it can say something untrue.
   *
   * Optional because a file written before this layer has none, and Part F's
   * forward-compatibility rule says such a file READS rather than throws. What
   * `blockCreatedAt` does about that is stated there.
   */
  createdAt?: Hlc;
  /** Set when a delete was recorded. Deletion is a tombstone, not an absence (C5). */
  deletedAt?: Hlc;
  /**
   * Set when a delete was taken back — the tombstone's opposite number.
   *
   * Not `Stamped`, for the same reason `deletedAt` is not: the value IS the
   * stamp. There is no payload two devices could disagree about, only which of
   * two events happened later, so `Stamped<true>` would be a boolean that is
   * always `true` sitting beside the only field that carries information.
   *
   * It exists rather than clearing `deletedAt` because clearing loses the
   * comparison. A device that restores by deleting the tombstone has no way to
   * tell a peer's arriving tombstone "I already decided about that one", so the
   * delete lands again — or, worse, resurfaces as a `delete_vs_edit` conflict
   * for a restore the person performed deliberately. Keeping both stamps makes
   * liveness a total function of the record, so two devices holding the same
   * bytes always agree about whether the block is there.
   */
  restoredAt?: Hlc;
  /** Fields whose merge could not be decided without losing work (D4). */
  conflicts?: Record<string, ConflictRecord>;
}

/** Kinds that hold no text, so an empty one is not an empty block to clean up. */
const TEXTLESS = new Set<NoteBlockKind>(['divider', 'page', 'table', 'database']);

export function isTextlessKind(kind: NoteBlockKind): boolean {
  return TEXTLESS.has(kind);
}

/**
 * Is this block currently there?
 *
 * The comparison, not the presence of a field: a restored block keeps its
 * tombstone so that the answer is derivable on any device from the record
 * alone. Every read path in Notes goes through this rather than testing
 * `deletedAt` directly — a caller that tests the field sees a restored block as
 * deleted, which is how a trash restore appears to do nothing.
 */
export function isLiveBlock(block: NoteBlock): boolean {
  if (!block.deletedAt) return true;
  return !!block.restoredAt && hlcAfter(block.restoredAt, block.deletedAt);
}

/** The tombstone that is currently in force, or null when the block is live. */
export function blockTombstone(block: NoteBlock): Hlc | null {
  return isLiveBlock(block) ? null : block.deletedAt ?? null;
}

export function blockHasConflicts(block: NoteBlock): boolean {
  return !!block.conflicts && Object.keys(block.conflicts).length > 0;
}

/** The reference that addresses this block from anywhere in the workspace (A1). */
export function noteBlockRef(blockId: string): WorkspaceRef {
  return { mode: NOTES_MODE, kind: NOTE_BLOCK_KIND, id: blockId };
}

export function noteBlockUri(blockId: string): string {
  return formatWorkspaceRef(noteBlockRef(blockId));
}

/* --------------------------------------------------------- page metadata */

/**
 * A page's title, which is the page block's OWN field — not its first child.
 *
 * E4 asks for "title as its own field", and this is the whole of it: `text` on
 * the page block already is that field, so there is nothing to add. A separate
 * `title` beside `text` would be E2's mistake in miniature — two fields that
 * must agree, merging independently, and the first concurrent edit leaves a
 * page whose heading and whose title are different sentences.
 *
 * The accessor exists so callers stop spelling `block.text.value` for a page,
 * which is what makes a second field look necessary later.
 */
export function pageTitle(block: NoteBlock): string {
  return block.text.value.trim();
}

/** What a page with no title is called. Never blank — a blank row is unclickable. */
export const UNTITLED_PAGE = 'Untitled';

export function pageTitleOrDefault(block: NoteBlock): string {
  return pageTitle(block) || UNTITLED_PAGE;
}

export function isFavourite(block: NoteBlock): boolean {
  return block.favourite?.value === true && isLiveBlock(block);
}

/**
 * F3 — is this page something to start FROM rather than something to read?
 *
 * The liveness check is part of the answer, not a caller's job: a template in
 * the trash must not stay in the "new page from…" list, or the one gesture that
 * makes a template useful resurrects a page somebody deliberately deleted.
 */
export function isTemplate(block: NoteBlock): boolean {
  return block.template?.value === true && isLiveBlock(block);
}

export function isCollapsed(block: NoteBlock): boolean {
  return block.collapsed?.value === true;
}
