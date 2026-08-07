/**
 * ADR-029 E4 — the block handle: what a drag means, what the menu offers, and
 * what "several blocks are selected" is.
 *
 * A page's body is a list of blocks in reading order, so all three questions are
 * about that order and none of them is markup. Keeping them here means the drag
 * that reorders across nesting levels can be tested without a pointer, and the
 * multi-block selection can be tested without a browser — which matters because
 * the failure everyone ships is an off-by-one at the ends of the range, and that
 * is invisible until someone deletes a block they did not mean to.
 *
 * The rules the sidebar already decided are IMPORTED rather than restated: a
 * drop's position within a row and the refusal to drop something inside itself
 * are the same judgements one level down, and two spellings of them would let a
 * drag in the page behave differently from the same drag in the tree.
 */
import { holdsProse, type NoteBlockKind } from '@kinqs/brainrouter-core/notes/editing';
import { dropPositionInRow, type PageDropPosition, type PageMoveIntent } from './pageTree.js';
import { noteBlockUri } from '../workspace/crossMode.js';
import type { NoteBlockView } from './notesView.js';

export { dropPositionInRow };
export type { PageDropPosition, PageMoveIntent };

/**
 * A selection is an anchor and a focus, never a set.
 *
 * The set is derived. Storing the ids instead would make shift-arrow ambiguous
 * the moment the person reverses direction — the anchor is what says which end
 * stays put, and a set has forgotten it.
 */
export interface BlockSelection {
  anchorId: string;
  focusId: string;
}

/** The blocks between the two ends, inclusive, in reading order. */
export function selectedBlockIds(
  body: readonly NoteBlockView[],
  selection: BlockSelection | null,
): string[] {
  if (!selection) return [];
  const anchor = body.findIndex((block) => block.id === selection.anchorId);
  const focus = body.findIndex((block) => block.id === selection.focusId);
  if (anchor < 0 || focus < 0) return [];
  const from = Math.min(anchor, focus);
  const to = Math.max(anchor, focus);
  return body.slice(from, to + 1).map((block) => block.id);
}

export function neighbourBlockId(
  body: readonly NoteBlockView[],
  id: string,
  direction: -1 | 1,
): string | null {
  const index = body.findIndex((block) => block.id === id);
  if (index < 0) return null;
  return body[index + direction]?.id ?? null;
}

/**
 * Shift-arrow: the focus moves, the anchor stays.
 *
 * Returns null at the ends of the page rather than wrapping. A selection that
 * jumped from the last block to the first would select the whole document from
 * a keystroke that asked for one more line.
 */
export function extendSelection(
  body: readonly NoteBlockView[],
  selection: BlockSelection | null,
  fromId: string,
  direction: -1 | 1,
): BlockSelection | null {
  const anchorId = selection?.anchorId ?? fromId;
  const focusId = selection?.focusId ?? fromId;
  const next = neighbourBlockId(body, focusId, direction);
  if (next === null) return selection;
  return { anchorId, focusId: next };
}

/** Is `candidateId` inside `ancestorId` by literal parentage, at any depth? */
export function isDescendantBlock(
  blocks: readonly NoteBlockView[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const seen = new Set<string>();
  let cursor = byId.get(candidateId)?.parentId ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * What dropping one block on another means, or null when it means nothing.
 *
 * `inside` is how a drag changes NESTING level, which is the half a reorder-only
 * drag cannot do — E4 asks for reordering across levels and a list that only
 * swaps siblings is not that.
 *
 * Dropping a block into its own subtree is refused at the gesture rather than
 * repaired afterwards: `parentId` merges last-writer-wins, so the store would
 * take it and the tree builder would break the cycle by detaching a member —
 * which the person sees as the block they dragged vanishing from where they put
 * it.
 */
export function blockDropIntent(
  blocks: readonly NoteBlockView[],
  dragId: string,
  targetId: string | null,
  position: PageDropPosition,
  pageId: string | null,
): PageMoveIntent | null {
  if (!dragId) return null;
  if (dragId === targetId) return null;
  if (targetId !== null && isDescendantBlock(blocks, dragId, targetId)) return null;
  // The page's background: the block leaves whatever it was nested in and
  // becomes a child of the page itself.
  if (targetId === null) return { id: dragId, parentId: pageId };

  if (position === 'inside') return { id: dragId, parentId: targetId };
  const target = blocks.find((block) => block.id === targetId);
  if (!target) return null;
  return position === 'before'
    ? { id: dragId, parentId: target.parentId, before: targetId }
    : { id: dragId, parentId: target.parentId, after: targetId };
}

/* ------------------------------------------------------------- the menu */

export type BlockAction = 'duplicate' | 'copy-link' | 'move-to' | 'delete';

/**
 * The handle's own actions, in the order they are offered.
 *
 * Delete is last and alone, because it is the only one that cannot be undone by
 * repeating it — and a destructive item beside a frequent one is how a fast
 * hand deletes a paragraph it meant to duplicate.
 */
export const BLOCK_ACTIONS: readonly { id: BlockAction; label: string }[] = [
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'copy-link', label: 'Copy link to block' },
  { id: 'move-to', label: 'Move to…' },
  { id: 'delete', label: 'Delete' },
];

/**
 * A2/A1 — the address a "copy link" puts on the clipboard.
 *
 * The same spelling every other surface writes, from the same helper: a link
 * copied here has to be the link the planner, the agent and the search index
 * would produce, or pasting it back would create a second name for one block.
 */
export function blockLinkUri(blockId: string): string {
  return noteBlockUri(blockId);
}

export interface MoveToTarget {
  /** Null is the top level, which is a real page (B4). */
  id: string | null;
  title: string;
}

/**
 * Where "move to…" can actually put this block.
 *
 * Its own subtree is excluded, and so is the page it is already on: offering a
 * move that changes nothing makes the menu look like it did not work.
 */
export function moveToTargets(
  blocks: readonly NoteBlockView[],
  blockId: string,
  currentPageId: string | null,
  topLevelLabel: string,
): MoveToTarget[] {
  const targets: MoveToTarget[] = [];
  if (currentPageId !== null) targets.push({ id: null, title: topLevelLabel });
  for (const block of blocks) {
    if (block.kind !== 'page') continue;
    if (block.id === blockId || block.id === currentPageId) continue;
    if (isDescendantBlock(blocks, blockId, block.id)) continue;
    targets.push({ id: block.id, title: (block.title ?? '').trim() || block.text.trim() || 'Untitled' });
  }
  return targets;
}

/**
 * Which slash-catalog commands are offered as "turn into".
 *
 * The ones whose text is prose, so the words survive the change. Turning a
 * written line into an image or a table would keep the block and silently drop
 * the sentence — the menu should not offer a conversion that deletes what it
 * was pointed at.
 */
export function turnIntoOptions<T extends { kind: string }>(commands: readonly T[]): T[] {
  return commands.filter((command) => holdsProse(command.kind as NoteBlockKind));
}
