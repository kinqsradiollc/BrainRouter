/**
 * ADR-029 E1/E2 — one block's text, as the thing a caret moves through.
 *
 * E2 stores a block's rich text IN the string as a restricted markdown subset.
 * That decision is right for merging — one field cannot disagree with itself —
 * and it hands the editor a problem: what a person sees (**bold** rendered) is
 * not what is stored (`**bold**`), so every keystroke has to be translated
 * between the two coordinate systems. This file is that translation, and every
 * function in it is pure so the answer can be pinned by a test rather than
 * discovered by typing.
 *
 * **The source string is the truth and the caret is measured in it.** The
 * rendered DOM is a projection: an edit is computed against the string and the
 * caret is put back afterwards by mapping. Reading the edit back OUT of the DOM
 * would mean re-deriving the marks from the rendering, which is the direction
 * that loses information — a `*` a person typed literally and a `*` that opened
 * an italic look identical once rendered.
 *
 * The ranges come from core's parser (`InlineSpan.start/end/textStart`), not
 * from a scanner here. A second scanner would eventually disagree about where a
 * delimiter ends, and one character of disagreement is a caret that lands inside
 * a `**` — in exactly the documents that use marks.
 */
import {
  parseInlineMarks, type InlineMark, type InlineSpan,
} from '@kinqs/brainrouter-core/notes/editing';

/** A span of core's parse, positioned in the visible text as well as the source. */
export interface InlineSegment {
  /** What the reader sees. */
  text: string;
  marks: readonly InlineMark[];
  href?: string;
  mention?: string;
  page?: string;
  /** Source range, delimiters included. */
  start: number;
  end: number;
  /** Where `text` starts in the source, when it is a verbatim slice of it. */
  textStart?: number;
  /** Where `text` starts in the concatenated visible text. */
  visibleStart: number;
}

export interface SourceSelection {
  start: number;
  end: number;
}

export interface TextEdit {
  text: string;
  caret: number;
}

/** The rendered form of a block's text, positioned in both coordinate systems. */
export function inlineSegments(text: string): InlineSegment[] {
  const spans: InlineSpan[] = parseInlineMarks(text ?? '');
  const out: InlineSegment[] = [];
  let visible = 0;
  for (const span of spans) {
    out.push({ ...span, visibleStart: visible });
    visible += span.text.length;
  }
  return out;
}

export function visibleTextOf(segments: readonly InlineSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

/**
 * A source offset, as an offset in the rendered text.
 *
 * An offset that falls inside a delimiter — between the two stars of `**` —
 * has no rendered position, so it resolves to the nearest edge of the span it
 * belongs to. Refusing to answer would mean a caret with nowhere to go after
 * an edit that landed there, which is a lost keystroke rather than a wrong one.
 */
export function sourceToVisible(segments: readonly InlineSegment[], source: number): number {
  const total = visibleTextOf(segments).length;
  if (segments.length === 0) return 0;
  const at = Math.max(0, Math.trunc(source));

  let best = 0;
  for (const segment of segments) {
    if (segment.textStart !== undefined) {
      const from = segment.textStart;
      const to = from + segment.text.length;
      if (at >= from && at <= to) return segment.visibleStart + (at - from);
    }
    if (at >= segment.start && at <= segment.end) {
      // Atomic: a link, a page link, an escaped character. The caret goes to
      // whichever side of it the offset is nearer, never into the middle.
      const middle = (segment.start + segment.end) / 2;
      return at < middle ? segment.visibleStart : segment.visibleStart + segment.text.length;
    }
    if (at > segment.end) best = segment.visibleStart + segment.text.length;
  }
  return clamp(best, 0, total);
}

/**
 * A rendered offset, as an offset in the source.
 *
 * The inverse of the above, with the same rule about atomic spans: a click in
 * the middle of a rendered link puts the caret beside the link rather than
 * inside its target, because typing inside a URI the reader cannot see is how
 * a reference silently stops resolving.
 */
export function visibleToSource(segments: readonly InlineSegment[], visible: number): number {
  if (segments.length === 0) return 0;
  const total = visibleTextOf(segments).length;
  const at = clamp(visible, 0, total);

  for (const segment of segments) {
    const from = segment.visibleStart;
    const to = from + segment.text.length;
    if (at < from || at > to) continue;
    if (segment.textStart !== undefined) return segment.textStart + (at - from);
    return at - from <= to - at ? segment.start : segment.end;
  }
  const last = segments[segments.length - 1]!;
  return last.end;
}

/** The segment a source offset sits inside, or null between two of them. */
export function segmentAt(segments: readonly InlineSegment[], source: number): InlineSegment | null {
  return segments.find((segment) => source > segment.start && source < segment.end) ?? null;
}

/* ------------------------------------------------------------------ edits */

/**
 * The typed edit: replace the selection with what was typed.
 *
 * Inserted text goes in RAW rather than escaped, so typing `**bold**` still
 * produces bold — the markdown someone types is the markdown they meant. E2's
 * escaping is for text a picker or a paste writes on their behalf, where the
 * person never saw the characters and cannot be surprised by them.
 */
export function replaceRange(text: string, selection: SourceSelection, insert: string): TextEdit {
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(Math.max(selection.end, start), start, text.length);
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/**
 * Backspace, which is three different things.
 *
 * With a selection it deletes it. Beside a link or a mention it removes the
 * whole reference rather than one character of a target the reader cannot see —
 * a half-deleted `[label](https://…` renders as prose nobody typed. Otherwise it
 * removes one CHARACTER, which is not the same as one UTF-16 unit: an emoji
 * with a skin tone is several units, and deleting one of them leaves a
 * different emoji on screen than the person was looking at.
 *
 * At column zero with nothing selected it returns `null`, meaning the keystroke
 * belongs to the block above — the caller routes it to core's merge.
 */
export function backspaceEdit(text: string, selection: SourceSelection): TextEdit | null {
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(Math.max(selection.end, start), start, text.length);
  if (end > start) return { text: text.slice(0, start) + text.slice(end), caret: start };
  if (start === 0) return null;

  const atomic = inlineSegments(text).find(
    (segment) => segment.textStart === undefined && segment.end === start && segment.end > segment.start,
  );
  if (atomic) {
    return { text: text.slice(0, atomic.start) + text.slice(atomic.end), caret: atomic.start };
  }

  const from = previousBoundary(text, start);
  return { text: text.slice(0, from) + text.slice(start), caret: from };
}

/** Forward delete. Null at the end of the block, where there is nothing to take. */
export function deleteForwardEdit(text: string, selection: SourceSelection): TextEdit | null {
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(Math.max(selection.end, start), start, text.length);
  if (end > start) return { text: text.slice(0, start) + text.slice(end), caret: start };
  if (start >= text.length) return null;

  const atomic = inlineSegments(text).find(
    (segment) => segment.textStart === undefined && segment.start === start && segment.end > segment.start,
  );
  const to = atomic ? atomic.end : nextBoundary(text, start);
  return { text: text.slice(0, start) + text.slice(to), caret: start };
}

/**
 * The characters that never stand alone.
 *
 * Combining marks, the emoji variation selector, the keycap mark, skin-tone
 * modifiers and the zero-width joiner. Deleting one of these on its own leaves a
 * DIFFERENT character on screen from the one the person was deleting, which
 * reads as the app having mangled their text.
 */
const ZERO_WIDTH_JOINER = 0x200d;

function isTrailer(codePoint: number | undefined): boolean {
  if (codePoint === undefined) return false;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return true;
  if (codePoint === 0xfe0f || codePoint === 0xfe0e || codePoint === 0x20e3) return true;
  if (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) return true;
  return codePoint === ZERO_WIDTH_JOINER;
}

function codePointStartBefore(text: string, index: number): number {
  if (index <= 0) return 0;
  const before = text.charCodeAt(index - 1);
  if (before >= 0xdc00 && before <= 0xdfff && index >= 2) {
    const lead = text.charCodeAt(index - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return index - 2;
  }
  return index - 1;
}

/** Where the character before `index` begins. */
export function previousBoundary(text: string, index: number): number {
  let at = clamp(index, 0, text.length);
  if (at === 0) return 0;
  at = codePointStartBefore(text, at);
  // Keep walking while what we are about to leave behind cannot stand alone,
  // or while a joiner sits before it (an emoji written as several joined ones).
  for (let guard = 0; guard < 32; guard += 1) {
    if (at === 0) break;
    const here = text.codePointAt(at);
    const previousStart = codePointStartBefore(text, at);
    const previous = text.codePointAt(previousStart);
    if (isTrailer(here) || previous === ZERO_WIDTH_JOINER) {
      at = previousStart;
      continue;
    }
    break;
  }
  return at;
}

/** Where the character at `index` ends. */
export function nextBoundary(text: string, index: number): number {
  let at = clamp(index, 0, text.length);
  if (at >= text.length) return text.length;
  const first = text.codePointAt(at)!;
  at += first > 0xffff ? 2 : 1;
  for (let guard = 0; guard < 32; guard += 1) {
    if (at >= text.length) break;
    const here = text.codePointAt(at)!;
    if (!isTrailer(here)) break;
    at += here > 0xffff ? 2 : 1;
  }
  return at;
}

/* ------------------------------------------------------------ line motion */

/**
 * Which visual row the caret is on, for the arrow keys that leave the block.
 *
 * Measured against the newlines in the text rather than against the laid-out
 * DOM. A soft-wrapped paragraph is one line by this rule and several on screen,
 * so ArrowUp from the second visual row of a wrapped paragraph leaves the block
 * rather than climbing within it. That is the honest limit of a judgement made
 * without a layout, and it is the right trade: the alternative is a decision
 * that cannot be tested and behaves differently in the dashboard.
 */
export function isOnFirstLine(text: string, caret: number): boolean {
  return text.slice(0, clamp(caret, 0, text.length)).indexOf('\n') < 0;
}

export function isOnLastLine(text: string, caret: number): boolean {
  return text.slice(clamp(caret, 0, text.length)).indexOf('\n') < 0;
}

/** How far along its line the caret is — the column an arrow key preserves. */
export function columnOf(text: string, caret: number): number {
  const at = clamp(caret, 0, text.length);
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return at - lineStart;
}

/**
 * The offset that best keeps a column when the caret arrives from another block.
 *
 * Clamped to the end of the target line rather than spilling onto the next one:
 * arriving in the middle of a word two lines down is not "the same column", it
 * is a caret nobody can predict.
 */
export function caretForColumn(text: string, column: number, edge: 'first' | 'last'): number {
  const lines = text.split('\n');
  const index = edge === 'first' ? 0 : lines.length - 1;
  const line = lines[index] ?? '';
  const within = Math.min(Math.max(column, 0), line.length);
  if (edge === 'first') return within;
  const before = lines.slice(0, index).reduce((sum, one) => sum + one.length + 1, 0);
  return before + within;
}

/* ------------------------------------------------ what the editor displays */

/**
 * Which version of the text a focused block shows.
 *
 * The store answers a write by re-reading (D4 merges, so the result of an edit
 * is not always the edit), and that answer arrives several keystrokes later. A
 * block that adopted it while someone was typing would drop those keystrokes
 * and move the caret — the single most destructive bug an editor can have.
 *
 * So a focused block keeps its own draft, and B2's lease is what makes that
 * safe: nobody else is writing to a block this device holds. An unfocused block
 * shows whatever arrived, unless the store has merely echoed our own last write
 * back at us, in which case the draft is the newer of the two.
 *
 * **`expected` is the one thing a focused block does take.** Enter in the
 * middle of a line is the case where this block asked core to REWRITE it, and
 * the truncation comes back while the block still has focus — before the caret
 * has moved to the new tail. Kept out by the rule above, that answer is never
 * offered again: the head goes on showing the whole line, and the next
 * keystroke in it pushes the pre-split text back over the split. So the caller
 * says what a cut at the caret would leave behind and this recognises it when
 * it arrives. That is not a second opinion about what Enter does — core still
 * decides, and decides otherwise for a table row, a code block and an empty
 * list item, in which cases nothing matches and nothing is adopted.
 */
export function textToShow(input: {
  incoming: string;
  draft: string;
  focused: boolean;
  lastPushed: string;
  /** What a split this block asked for would leave IN it, while one is outstanding. */
  expected?: string | null;
}): string {
  if (input.expected !== undefined && input.expected !== null && input.incoming === input.expected) {
    return input.incoming;
  }
  if (input.focused) return input.draft;
  if (input.incoming === input.lastPushed) return input.draft;
  return input.incoming;
}

/* --------------------------------------------------------- input rules */

/** What `notes-input-rule` hands back when a marker fired. */
export interface InputRuleTransformDto {
  ruleId: string;
  marker: string;
  kind: string;
  text: string;
  caret: number;
  level?: number;
  checked?: boolean;
  language?: string;
}

/**
 * Is this rule still about the text on screen?
 *
 * The rule is decided in core through the host, so the answer arrives after a
 * round trip — and a person can type another character in that time. Applying a
 * stale transform would overwrite what they typed with the tail the marker left
 * behind, which is a keystroke silently eaten by a feature that is supposed to
 * help. A rule that missed its moment does nothing; the marker stays as text and
 * the next space tries again.
 */
export function inputRuleStillApplies(requested: string, current: string): boolean {
  return requested === current;
}

/* ------------------------------------------------------------- undo */

/**
 * The undo stack the controlled editor has to bring its own.
 *
 * A textarea gets undo from the browser. This editor computes every edit
 * itself and prevents the browser's, so the browser's history stays empty and
 * ⌘Z would do nothing — which is not a missing nicety but the first thing
 * anyone reaches for after a mistake.
 *
 * **A run of typing is ONE undo.** Recording per keystroke would make ⌘Z walk
 * backwards one character at a time, which is worse than no undo because the
 * person has to guess how many times to press it. The run is detected
 * structurally — one character added at the caret, continuing where the last
 * one ended — rather than by a timer, so the rule is the same on a fast
 * machine and a slow one.
 */
export interface EditHistory {
  past: readonly TextEdit[];
  future: readonly TextEdit[];
  /** Where the run being coalesced currently ends, or null when there is none. */
  runCaret: number | null;
}

/** Deep enough for a page's worth of edits, bounded so a long session cannot grow forever. */
const HISTORY_LIMIT = 200;

export const EMPTY_HISTORY: EditHistory = { past: [], future: [], runCaret: null };

export function recordEdit(history: EditHistory, before: TextEdit, after: TextEdit): EditHistory {
  const typing = after.text.length === before.text.length + 1 && after.caret === before.caret + 1;
  // Already inside a run: its starting state is on the stack, so this keystroke
  // adds nothing to undo.
  if (typing && history.runCaret === before.caret) {
    return { past: history.past, future: [], runCaret: after.caret };
  }
  return {
    past: [...history.past, before].slice(-HISTORY_LIMIT),
    // Any new edit abandons the redo branch, or ⌘⇧Z would replay something
    // that never happened after it.
    future: [],
    runCaret: typing ? after.caret : null,
  };
}

export function undoEdit(history: EditHistory, current: TextEdit): { history: EditHistory; edit: TextEdit } | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future], runCaret: null },
    edit: previous,
  };
}

export function redoEdit(history: EditHistory, current: TextEdit): { history: EditHistory; edit: TextEdit } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(1), runCaret: null },
    edit: next,
  };
}

/* ------------------------------------------------------ IME composition */

/**
 * An input method's session, which is the one edit this file cannot control.
 *
 * Every other keystroke is intercepted before the DOM changes, so the source
 * string stays the single truth. A composition cannot be: the browser refuses to
 * let `insertCompositionText` be prevented, and re-rendering the block while a
 * candidate window is open cancels it and loses the characters. So the DOM is
 * allowed to be ahead of the model for the length of one composition, and
 * exactly one commit lands at the end of it.
 *
 * The reducer exists so that "exactly one" is a tested property rather than a
 * claim about event ordering. Committing per update would write a partial
 * reading into the document — the state a Japanese or Korean typist sees before
 * choosing a candidate — and the person would watch their sentence rewrite
 * itself as they typed it.
 */
export interface CompositionSession {
  /** The block text when the composition began. */
  source: string;
  /** The source range the edited DOM text node covers. */
  nodeStart: number;
  nodeEnd: number;
  /** That node's text before anything was composed. */
  before: string;
}

export type CompositionState = CompositionSession | null;

export type CompositionEvent =
  | { type: 'start'; source: string; nodeStart: number; nodeEnd: number; before: string }
  | { type: 'update' }
  | { type: 'end'; after: string; caretInNode?: number };

export interface CompositionStep {
  state: CompositionState;
  /** Set on exactly one event of a session: the one that ends it. */
  commit?: TextEdit;
}

export function reduceComposition(state: CompositionState, event: CompositionEvent): CompositionStep {
  if (event.type === 'start') {
    return {
      state: {
        source: event.source,
        nodeStart: Math.max(0, event.nodeStart),
        nodeEnd: Math.max(event.nodeStart, event.nodeEnd),
        before: event.before,
      },
    };
  }
  // Updates are deliberately inert. They carry the half-composed reading, and
  // writing that into the document is what makes a sentence rewrite itself.
  if (event.type === 'update') return { state };
  // An end with no session is not an error: a composition can be cancelled by a
  // blur, and reacting to the stray event would commit text twice.
  if (state === null) return { state: null };

  const head = state.source.slice(0, state.nodeStart);
  const tail = state.source.slice(state.nodeEnd);
  const caret = state.nodeStart + (event.caretInNode ?? event.after.length);
  return {
    state: null,
    commit: { text: head + event.after + tail, caret: Math.min(caret, (head + event.after).length) },
  };
}
