/**
 * ADR-029 E1 — what a key press means inside a block.
 *
 * E1's parity test is that a person who already uses one of these apps can type
 * a page here without being taught anything, and that sentence is decided by
 * about a dozen key presses: Enter splits, Backspace at column zero merges, Tab
 * nests, the arrows leave the block at its edges, ⌘B bolds. None of them is
 * markup, all of them are judgements, and a judgement made inside a keydown
 * handler is one nobody can test and one the dashboard will make differently.
 *
 * So the handler asks this file what a press MEANS and then performs it. The
 * intents map onto gestures core already implements (`notes-split`,
 * `notes-merge-back`, `notes-indent`…) rather than onto edits, because core owns
 * the structural half — where a split's tail goes, whether Backspace unstyles or
 * outdents — and this file owns only which keystroke asks for it.
 *
 * **A modifier is `meta` on macOS and `ctrl` everywhere else**, taken from the
 * event rather than sniffed from the platform: the same build runs on both, and
 * a hardcoded key would make one of them silently unable to bold anything.
 */
import type { InlineMark } from '@kinqs/brainrouter-core/notes/editing';
import { columnOf, isOnFirstLine, isOnLastLine } from './blockEditing.js';
import { atFirstVisualRow, atLastVisualRow, type VisualRowGeometry } from './visualRows.js';

export type BlockIntent =
  /** Enter — core splits at the caret. */
  | { kind: 'split' }
  /** Backspace at column zero — core merges into the block above. */
  | { kind: 'merge-back' }
  | { kind: 'indent' }
  | { kind: 'outdent' }
  | { kind: 'move-up' }
  | { kind: 'move-down' }
  | { kind: 'duplicate' }
  /**
   * The caret leaves this block, keeping its horizontal position.
   *
   * `x` is where the caret was on screen and is what the neighbour actually uses
   * (F3): on a wrapped paragraph a character column names two different places
   * depending on which row you land in, while the x is the thing the reader's
   * eye is tracking. `column` stays as the fallback for a surface with no
   * layout to measure — the browser dev harness before first paint, and the
   * tests.
   */
  | { kind: 'caret-up'; column: number; x?: number }
  | { kind: 'caret-down'; column: number; x?: number }
  /** Shift-arrow past the edge — the selection becomes several blocks (E4). */
  | { kind: 'select-up' }
  | { kind: 'select-down' }
  | { kind: 'toggle-mark'; mark: InlineMark }
  /** ⌘K over a selection writes a link rather than opening quick find. */
  | { kind: 'link' }
  /** Shift-Enter, and Enter inside code: a newline in this block. */
  | { kind: 'newline' }
  /**
   * ⌘Z / ⌘⇧Z. The editor computes every edit itself and prevents the
   * browser's, so the browser's own history is empty and this is the only undo
   * there is.
   */
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'escape' }
  /** Not ours — the browser inserts the character. */
  | { kind: 'none' };

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface BlockKeyContext {
  text: string;
  selection: { start: number; end: number };
  kind: string;
  /**
   * A menu is taking the arrows and Enter.
   *
   * The slash menu and the mention picker are keyboard surfaces of their own,
   * and a block that also acted on ArrowDown would move the caret out from
   * under the menu the person is choosing from.
   */
  menuOpen?: boolean;
  /** True while an input method owns the keystrokes (see `reduceComposition`). */
  composing?: boolean;
  /**
   * F3 — where the block's rows and the caret actually are.
   *
   * Absent when nothing has been laid out yet, in which case the newline rule
   * below is used. That fallback is Part E's behaviour, kept deliberately: it is
   * wrong for a wrapped paragraph and right for everything else, which makes it
   * the correct thing to degrade to rather than refusing to move the caret.
   */
  geometry?: VisualRowGeometry;
}

function mod(event: KeyLike): boolean {
  return event.metaKey || event.ctrlKey;
}

const MARK_KEYS: Record<string, InlineMark> = { b: 'bold', i: 'italic', e: 'code' };

/**
 * What this press asks for.
 *
 * Returns `none` far more often than anything else, and that is the normal
 * outcome: a key that is not a gesture is a character, and the editor's text
 * path handles it.
 */
export function blockKeyIntent(event: KeyLike, ctx: BlockKeyContext): BlockIntent {
  // An input method owns the keyboard until it is done. Acting on Enter here
  // would split the block when the person meant "accept this candidate".
  if (ctx.composing) return { kind: 'none' };
  if (event.key === 'Escape') return { kind: 'escape' };
  if (ctx.menuOpen && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab'].includes(event.key)) return { kind: 'none' };

  const collapsed = ctx.selection.start === ctx.selection.end;

  if (event.key === 'Enter') {
    if (event.shiftKey) return { kind: 'newline' };
    // Code is verbatim: a newline in it is a newline, not a new block. Core
    // refuses the split for the same reason, so this only saves the round trip.
    if (ctx.kind === 'code') return { kind: 'newline' };
    return { kind: 'split' };
  }

  if (event.key === 'Backspace' && collapsed && ctx.selection.start === 0) return { kind: 'merge-back' };

  if (event.key === 'Tab') return event.shiftKey ? { kind: 'outdent' } : { kind: 'indent' };

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const up = event.key === 'ArrowUp';
    // F3 — the LAID-OUT edge when there is one. Not the newline edge, which
    // reported every row of a wrapped paragraph as the first: the caret left the
    // block from the middle of it, and climbing a paragraph with the keyboard
    // was impossible.
    const atEdge = ctx.geometry
      ? (up ? atFirstVisualRow(ctx.geometry) : atLastVisualRow(ctx.geometry))
      : (up ? isOnFirstLine(ctx.text, ctx.selection.start) : isOnLastLine(ctx.text, ctx.selection.end));
    // ⌘⇧↑ moves the BLOCK; the same keys without the modifier move the caret.
    if (mod(event) && event.shiftKey) return up ? { kind: 'move-up' } : { kind: 'move-down' };
    // Not at an edge: the browser moves the caret within this block, which is
    // exactly the right behaviour and is why this returns `none` rather than
    // computing a row of its own.
    if (!atEdge) return { kind: 'none' };
    if (event.shiftKey) return up ? { kind: 'select-up' } : { kind: 'select-down' };
    const x = ctx.geometry?.caret.left;
    return up
      ? { kind: 'caret-up', column: columnOf(ctx.text, ctx.selection.start), ...(x === undefined ? {} : { x }) }
      : { kind: 'caret-down', column: columnOf(ctx.text, ctx.selection.end), ...(x === undefined ? {} : { x }) };
  }

  if (mod(event)) {
    const letter = event.key.toLowerCase();
    if (letter === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    // The Windows spelling of redo, because the same build runs there.
    if (letter === 'y' && !event.shiftKey) return { kind: 'redo' };
    if (letter === 'd' && !event.shiftKey) return { kind: 'duplicate' };
    if (letter === 'k' && !collapsed) return { kind: 'link' };
    if (event.shiftKey && (letter === 's' || letter === 'x')) return { kind: 'toggle-mark', mark: 'strike' };
    const mark = MARK_KEYS[letter];
    if (mark && !event.shiftKey) return { kind: 'toggle-mark', mark };
  }

  return { kind: 'none' };
}

/**
 * Does this intent belong to the block, or to the window?
 *
 * ⌘K is quick find everywhere in the mode and a link inside a selection, so the
 * block has to be able to say "this one is mine" — otherwise the shortcut that
 * writes a link also opens a search panel over the top of it.
 */
export function stopsWindowShortcut(intent: BlockIntent): boolean {
  return intent.kind !== 'none';
}
