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
 */
import type { Hlc } from '../sync/hybridClock.js';
import type { ConflictRecord, Stamped } from '../sync/stamped.js';
import { formatWorkspaceRef, type WorkspaceRef } from '../workspace/references/ref.js';

/** The mode segment every note reference carries. */
export const NOTES_MODE = 'notes';
/** The kind segment. One kind, because B4 refuses a second one for pages. */
export const NOTE_BLOCK_KIND = 'block';

export type NoteBlockKind =
  | 'page'
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'todo'
  | 'quote'
  | 'code'
  /** Text is a single workspace reference, rendered live (A3). */
  | 'embed'
  | 'divider';

export const NOTE_BLOCK_KINDS: readonly NoteBlockKind[] = [
  'page', 'heading', 'paragraph', 'bullet', 'todo', 'quote', 'code', 'embed', 'divider',
];

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
  /** Set when a delete was recorded. Deletion is a tombstone, not an absence (C5). */
  deletedAt?: Hlc;
  /** Fields whose merge could not be decided without losing work (D4). */
  conflicts?: Record<string, ConflictRecord>;
}

/** Kinds that hold no text, so an empty one is not an empty block to clean up. */
const TEXTLESS = new Set<NoteBlockKind>(['divider', 'page']);

export function isTextlessKind(kind: NoteBlockKind): boolean {
  return TEXTLESS.has(kind);
}

export function isLiveBlock(block: NoteBlock): boolean {
  return !block.deletedAt;
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
