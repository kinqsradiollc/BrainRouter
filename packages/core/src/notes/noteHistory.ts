/**
 * ADR-029 F4 — undo is per PAGE, and it is a stack of inverse operations.
 *
 * Part E shipped undo per block and text-only, because the controlled editor
 * intercepts every `beforeinput` and leaves the browser's own history empty. F4
 * states the consequence plainly: **a split, a merge, an indent or a delete
 * could not be undone at all.** That is the failure people fear most in a notes
 * app, and "⌘Z did nothing" teaches them not to trust the editor with anything
 * they care about.
 *
 * This file is the MODEL — what an entry is, how the stack is bounded, and the
 * one question that decides whether an undo is safe to apply. The mutations are
 * recorded in `noteStore`, where they happen, because F4 says so and because the
 * alternative was tried: a stack kept in the component covers only what the
 * component did, and loses everything on a re-render.
 *
 * **Per page, not per workspace.** An entry records the page it belongs to and
 * ⌘Z pops the newest entry for the page being read. One global stack would let
 * ⌘Z on a page undo an edit made ten minutes ago on a different page — a
 * keystroke whose effect is off screen, which is the worst possible property for
 * the gesture people use when they are already worried.
 *
 * **The inverse is a real inverse.** Undoing a delete restores the block WITH
 * its children and at its own rank, not an empty block at the end; undoing a
 * move writes back the exact `parentId` and `rank` rather than re-deriving a
 * position from neighbours that have since changed.
 *
 * **The guard is the part that is not a convenience.** Undoing over someone
 * else's edit is a data-loss bug wearing a familiar keyboard shortcut: the
 * inverse would write a value from before their change, their sentence would
 * disappear, and the person who pressed ⌘Z would have no idea they had
 * overwritten anything. So every entry records the stamp THIS device wrote per
 * block, and an undo is refused — whole, never partly — when a stamp from
 * another device has landed on any of them since.
 */
import { hlcAfter, type Hlc } from '../sync/hybridClock.js';
import type { UpdateBlockInput } from './noteStore.js';

/**
 * One step back.
 *
 * Four shapes, and no more: everything the store can do to a block is a field
 * write, a placement, a tombstone or the taking back of one. A vocabulary that
 * grew per gesture would need a new inverse for every gesture added later, and
 * the one that got forgotten would be the one ⌘Z silently skipped.
 */
export type NoteInverseOp =
  /** The previous values of exactly the fields an update wrote. */
  | { op: 'fields'; blockId: string; fields: UpdateBlockInput }
  /** Where the block was, exactly — the rank, not a neighbour to re-derive from. */
  | { op: 'place'; blockId: string; parentId: string | null; rank: string }
  /** Undo of a creation. A tombstone, so redo has something to take back. */
  | { op: 'delete'; blockId: string }
  /** Undo of a delete: the subtree that went, by id. */
  | { op: 'restore'; blockIds: readonly string[] };

export interface NoteUndoEntry {
  id: string;
  /** What ⌘Z is about to take back, in words a person recognises. */
  label: string;
  /** Which page's stack this is on. `null` is the top level, which is a real page (B4). */
  pageId: string | null;
  /**
   * The inverses, in the order the mutations happened.
   *
   * Applied in REVERSE, because a gesture's mutations are ordered for a reason:
   * a merge writes the block above and then deletes this one, so undoing it has
   * to restore this one before putting the text back.
   */
  ops: readonly NoteInverseOp[];
  /**
   * Per block, the stamp this device wrote when the entry was recorded.
   *
   * Compared against what the block carries now, so an undo can tell "nothing
   * has happened since" from "somebody else has been here".
   */
  guard: Record<string, Hlc>;
  at: Hlc;
}

export interface NoteHistory {
  past: NoteUndoEntry[];
  future: NoteUndoEntry[];
}

export function emptyNoteHistory(): NoteHistory {
  return { past: [], future: [] };
}

/**
 * How many steps back a page's stack goes.
 *
 * Deep enough that a session's structural edits are all reachable, bounded
 * because the stack is persisted beside the blocks and an unbounded one grows
 * with how long the app has been open rather than with what is in it.
 */
export const MAX_UNDO_ENTRIES = 120;

/**
 * The stack's second bound, in characters of remembered text.
 *
 * Entry count alone is not a bound: one inverse can hold a 64,000-character
 * paragraph, so a hundred of them is six megabytes in a file that is read and
 * rewritten on every keystroke's debounce. Oldest entries are dropped until the
 * budget is met — losing the far end of a long session's undo is a cost people
 * can live with; a store file that takes half a second to parse is not.
 */
export const MAX_UNDO_TEXT = 400_000;

function entryTextSize(entry: NoteUndoEntry): number {
  let size = 0;
  for (const op of entry.ops) {
    if (op.op !== 'fields') continue;
    if (typeof op.fields.text === 'string') size += op.fields.text.length;
  }
  return size;
}

/**
 * Put an entry on the stack, and drop whatever no longer fits.
 *
 * The FUTURE is cleared by the caller rather than here, because a redo applying
 * its own inverse also comes through this function — and clearing on every push
 * would make one redo destroy the rest of the redo branch.
 */
export function pushUndoEntry(stack: readonly NoteUndoEntry[], entry: NoteUndoEntry): NoteUndoEntry[] {
  const next = [...stack, entry].slice(-MAX_UNDO_ENTRIES);
  let size = next.reduce((sum, one) => sum + entryTextSize(one), 0);
  while (next.length > 1 && size > MAX_UNDO_TEXT) {
    size -= entryTextSize(next[0]!);
    next.shift();
  }
  return next;
}

/** The newest entry for a page, or -1. Pages have separate stacks — see the header. */
export function newestEntryIndex(stack: readonly NoteUndoEntry[], pageId: string | null): number {
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    if ((stack[at]!.pageId ?? null) === (pageId ?? null)) return at;
  }
  return -1;
}

/** The blocks an entry NAMES. What it would actually write to can be wider — see below. */
export function entryBlockIds(entry: NoteUndoEntry): string[] {
  const ids = new Set<string>();
  for (const op of entry.ops) {
    if (op.op === 'restore') for (const id of op.blockIds) ids.add(id);
    else ids.add(op.blockId);
  }
  return [...ids];
}

/**
 * Every block an entry would actually write to, which is not every block it
 * names.
 *
 * `delete` names one id and `deleteBlock` tombstones the whole SUBTREE — that is
 * its rule, and it is the right one. But the guard was given the named id alone,
 * so undoing anything whose inverse is a delete (adding a block, a split, a
 * duplicate) tombstoned whatever a peer had nested inside it since, stamped it
 * with this device's id, and queued it to the server. That is cross-device data
 * loss reached by pressing ⌘Z, so the guard has to ask about the same set the
 * inverse will touch.
 *
 * `subtreeOf` is passed in because the store owns the tree and this file owns
 * the entry; a copy of the walk here would be a second answer to "what is under
 * this block", and the first thing it would get wrong is the case nobody can
 * reproduce.
 */
export function entryWriteTargets(
  entry: NoteUndoEntry,
  subtreeOf: (blockId: string) => readonly string[],
): string[] {
  const ids = new Set<string>();
  for (const op of entry.ops) {
    if (op.op === 'restore') { for (const id of op.blockIds) ids.add(id); continue; }
    ids.add(op.blockId);
    if (op.op === 'delete') for (const id of subtreeOf(op.blockId)) ids.add(id);
  }
  return [...ids];
}

/**
 * Has another device written to anything this entry would rewrite?
 *
 * Returns the block id that stops the undo, or null when it is safe. The
 * comparison is deliberately about the DEVICE and not merely about the stamp: a
 * later stamp from this device is either the entry above it on the stack (which
 * has already been undone, since the stack pops newest first) or an edit the
 * same person made, and refusing on those would make ⌘Z stop working for the one
 * user it is meant to serve.
 *
 * A remote write is different in kind. The inverse holds a value from before it,
 * so applying the entry would put that value back over theirs — silently,
 * because the person pressing ⌘Z is looking at their own last action, not at the
 * paragraph that changed underneath it.
 */
export function remoteChangeUnder(
  entry: NoteUndoEntry,
  editedAt: (blockId: string) => Hlc | undefined,
  localDeviceId: string,
  subtreeOf: (blockId: string) => readonly string[] = () => [],
): string | null {
  for (const blockId of entryWriteTargets(entry, subtreeOf)) {
    const now = editedAt(blockId);
    if (!now) continue;
    if (now.deviceId === localDeviceId) continue;
    const guard = entry.guard[blockId];
    // No guard stamp AND a remote write means a block this entry never knew
    // about — a peer's paragraph nested under the one being taken back. That is
    // the case the subtree expansion exists to catch, so it must refuse rather
    // than fall through as "nothing recorded, nothing to compare".
    if (!guard || hlcAfter(now, guard)) return blockId;
  }
  return null;
}

/**
 * What a refused undo says.
 *
 * Names the situation rather than the mechanism: "another device changed this"
 * is actionable — look at the page, decide, edit again — while "stale guard
 * stamp" is a sentence about our data structures that leaves the person
 * pressing ⌘Z harder.
 */
export function describeRefusedUndo(label: string): string {
  return `“${label}” cannot be undone: another device has changed one of these blocks since. `
    + 'Undoing would write over their change.';
}

/**
 * The sentences ⌘Z uses, in one place.
 *
 * A label is shown after the fact ("Undid: moved a block"), so it names the
 * ACTION and not the keystroke. Kept here rather than at each call site because
 * the same gesture is recorded from two files and two spellings of one action
 * read as two different things having happened.
 */
export const UNDO_LABELS = {
  edit: 'the edit',
  insert: 'adding a block',
  split: 'splitting the block',
  merge: 'joining the blocks',
  indent: 'nesting the block',
  outdent: 'un-nesting the block',
  move: 'moving the block',
  duplicate: 'duplicating',
  delete: 'the delete',
  restore: 'the restore',
  template: 'the template',
} as const;

/*
 * There is deliberately no label for a COMMENT.
 *
 * Comment writes are not recorded on this stack — see `writeComment` in
 * `noteStore.ts` for why: ⌘Z after typing a paragraph must not silently retract
 * a remark addressed to somebody else. A label here with nothing recording
 * against it would be the first thing a later reader wired up.
 */

export type NoteUndoLabel = typeof UNDO_LABELS[keyof typeof UNDO_LABELS];
