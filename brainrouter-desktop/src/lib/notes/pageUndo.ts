/**
 * ADR-029 F4 — where ⌘Z goes, and what it says when it refuses.
 *
 * There are two undo stacks and that is deliberate, not an accident of the port:
 *
 *  - the BLOCK's, in `blockEditing.ts`, which coalesces a run of typing and
 *    applies instantly because it never leaves the renderer;
 *  - the PAGE's, in core's store, which holds the inverse of every structural
 *    mutation — a split, a merge, an indent, a move, a delete — and of every
 *    text write that has actually been pushed.
 *
 * A single stack was tried in the head and does not work: putting typing on the
 * page stack means a round trip per keystroke, and putting structure on the
 * block stack means a component owns the inverse of a delete, which is exactly
 * what F4 says must not happen because a re-render loses it.
 *
 * **So the rule is one sentence: ⌘Z walks the block's own typing first, and
 * falls through to the page the moment there is none left.** That is what makes
 * the two feel like one stack. After a split the caret is in a NEW block whose
 * typing history is empty, so the very next ⌘Z reaches the page and undoes the
 * split — which is the gesture F4 was written about.
 */

export type UndoRoute = 'text' | 'page';

/**
 * Which stack this ⌘Z belongs to.
 *
 * Taking the block's first rather than the page's, because the block's is finer:
 * a person who has typed three words and presses ⌘Z means those words, and
 * reaching past them to undo the split that made the block would delete the
 * words as a side effect of undoing something else.
 */
export function undoRoute(input: { blockHasHistory: boolean }): UndoRoute {
  return input.blockHasHistory ? 'text' : 'page';
}

/** The same rule forwards. ⌘⇧Z replays the block's typing before the page's. */
export function redoRoute(input: { blockHasFuture: boolean }): UndoRoute {
  return input.blockHasFuture ? 'text' : 'page';
}

/** What the host answers for a page-level undo, as the renderer sees it. */
export interface PageUndoDto {
  ok?: boolean;
  direction?: 'undo' | 'redo';
  label?: string;
  focusId?: string | null;
  changedIds?: string[];
  reason?: string;
  detail?: string;
  blockId?: string;
}

/**
 * The line shown after a ⌘Z, or null when there is nothing worth saying.
 *
 * **A refusal is always said out loud.** F4's guard exists because undoing over
 * somebody else's edit is a data-loss bug wearing a familiar shortcut — and a
 * guard that silently declines is indistinguishable from the bug F4 was written
 * to fix ("⌘Z did nothing"). The two situations it can refuse for are different
 * and lead somewhere different, so they get different sentences: a remote change
 * means look at the page, a lock means wait a moment.
 *
 * A SUCCESSFUL undo says nothing. The document changing in front of you is the
 * feedback, and a toast for every keystroke of a ⌘Z run is noise that trains
 * people to ignore the one that matters.
 */
export function undoNotice(answer: PageUndoDto | null): string | null {
  if (!answer) return 'That could not be undone.';
  if (answer.ok) return null;
  switch (answer.reason) {
    case 'nothing_to_undo':
      return 'There is nothing left to undo on this page.';
    case 'nothing_to_redo':
      return 'There is nothing to redo on this page.';
    case 'remote_change':
    case 'locked':
      // Core wrote the sentence, because core knows which step it refused and
      // why; re-deriving it here would let the desktop and the dashboard explain
      // the same refusal two ways.
      return answer.detail ?? 'That could not be undone — the page has changed since.';
    default:
      return answer.detail ?? 'That could not be undone.';
  }
}

/**
 * Whether a refusal should also draw attention to a block.
 *
 * A sentence saying "another device changed one of these blocks" is only useful
 * if you can see WHICH — otherwise the person has to diff a page by eye against
 * a memory of what they last typed.
 */
export function undoHighlightId(answer: PageUndoDto | null): string | null {
  if (!answer || answer.ok) return null;
  return answer.blockId ?? null;
}

/**
 * What a menu entry for ⌘Z should read, given what the page's stack holds.
 *
 * Named rather than generic for F1's reason applied to a menu: an "Undo" item
 * that is always enabled and sometimes does nothing is the same broken promise
 * as a slash-menu entry whose block has no renderer.
 */
export function undoMenuLabel(label: string | null, direction: 'undo' | 'redo'): string {
  const verb = direction === 'undo' ? 'Undo' : 'Redo';
  return label ? `${verb} ${label}` : `Nothing to ${direction}`;
}
