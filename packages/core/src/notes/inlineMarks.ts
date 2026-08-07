/**
 * ADR-029 E2 — rich text stored IN the string, and the parser that reads it back.
 *
 * The alternative was a parallel `Stamped<InlineMark[]>` holding offsets into a
 * separately-stamped body. Two fields that must agree about lengths, merging
 * independently: the first concurrent edit desynchronises them and produces
 * bold that starts mid-word in a sentence neither person wrote. One field
 * cannot disagree with itself.
 *
 * The price E2 names is escaping — a `*` someone typed literally has to survive
 * a round trip — and that price is paid here, once, rather than by every
 * surface that renders a block. `escapeInline` is the write half and
 * `parseInlineMarks` the read half, and the property that matters is that
 * composing them returns exactly what went in. It is tested, because an
 * escaping scheme that is only nearly reversible corrupts one character in a
 * thousand blocks, which is indistinguishable from the user mistyping.
 *
 * **The subset is closed on purpose.** Bold, italic, strike, inline code, a
 * link, an `@`-mention and a `[[page link]]` — nothing else parses, so text
 * that happens to look like other markdown stays text. Accepting "whatever
 * markdown someone pastes" would mean a pasted `#` heading silently restyles a
 * paragraph and a table of ASCII art becomes a table.
 *
 * Marks NEST (bold inside a link, italic inside bold) but inline code does not:
 * its contents are literal, because the one thing people put in backticks is
 * text they do not want interpreted.
 */
import { isWorkspaceRefString, WORKSPACE_REF_SCHEME } from '../workspace/references/ref.js';

export type InlineMark = 'bold' | 'italic' | 'strike' | 'code';

export const INLINE_MARKS: readonly InlineMark[] = ['bold', 'italic', 'strike', 'code'];

/** The delimiter each mark is written with. Order matters: `**` is tried before `*`. */
export const MARK_DELIMITERS: Record<InlineMark, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

export interface InlineSpan {
  text: string;
  marks: readonly InlineMark[];
  /** `[label](https://…)` — an ordinary hyperlink. */
  href?: string;
  /** `@[label](brainrouter://…)` or a bare URI — a live workspace reference (A3). */
  mention?: string;
  /** `[[Some page]]` — a page addressed by title, resolved by the caller. */
  page?: string;
  /**
   * Where in the SOURCE this span came from, delimiters included.
   *
   * E2 stores the marks in the string, which means an editor showing the
   * rendered form has to be able to answer "the caret is here on screen — where
   * is that in the string?" for every keystroke. Without ranges the only way to
   * answer it is a second scanner in the renderer, and two parsers disagreeing
   * about where a `*` ends is a caret that lands one character off in exactly
   * the documents that use marks.
   */
  start: number;
  end: number;
  /**
   * Where `text` begins in the source, when `text` is a VERBATIM slice of it.
   *
   * Absent when the span is atomic — a link, a page link, an escaped character —
   * because a caret cannot meaningfully sit three characters into something
   * whose visible form is not the source's. A caller maps those to an edge.
   */
  textStart?: number;
}

/**
 * What a backslash may precede.
 *
 * Wider than what `escapeInline` writes, and deliberately: a person typing
 * `\]` means a literal bracket and should get one, even though nothing would
 * have parsed it as a delimiter anyway. A backslash before anything else stays
 * a backslash, so a Windows path in prose does not disappear one character at
 * a time.
 */
const ESCAPABLE = new Set(['\\', '*', '~', '`', '[', ']', '(', ')', '@']);

/**
 * What `escapeInline` writes an escape for: the characters that can OPEN a
 * construct.
 *
 * Escaping closers as well would be safe and unreadable — `a\)b` for text
 * nothing was ever going to parse. A link needs its `[`, a mention its `@`, a
 * page link its `[[`; without an opener a stray `]` or `)` is already inert.
 */
const OPENERS = new Set(['\\', '*', '~', '`', '[', '@']);

/** Guards a pathological input from turning one paste into quadratic work. */
const MAX_INLINE_LENGTH = 64_000;

/** Make text literal: everything that could open a construct is escaped. */
export function escapeInline(raw: string): string {
  let out = '';
  for (const ch of raw) out += OPENERS.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** Strip escapes without interpreting anything. The inverse of `escapeInline`. */
export function unescapeInline(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && ESCAPABLE.has(text[i + 1] ?? '')) {
      out += text[i + 1];
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/* ----------------------------------------------------------------- parsing */

interface Run {
  spans: InlineSpan[];
  end: number;
  /** False when the closing delimiter never arrived, so the opener is literal. */
  closed: boolean;
}

/**
 * The block's text as styled spans.
 *
 * Never throws and never rejects: this runs over content a person is in the
 * middle of typing, so a half-written `**bo` has to render as the characters
 * that are there. An unclosed delimiter is literal text, which is also what
 * makes typing one feel like nothing happened rather than like the rest of the
 * paragraph vanished.
 */
export function parseInlineMarks(text: string): InlineSpan[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const source = text.length > MAX_INLINE_LENGTH ? text.slice(0, MAX_INLINE_LENGTH) : text;
  return parseRun(source, 0, null, [], 0).spans;
}

/**
 * `base` is where `text` itself starts in the whole source.
 *
 * A link's label is parsed as its own run over the label substring, so without
 * a base the spans inside `[**bold** label](…)` would report offsets relative to
 * the label rather than to the block — which is a caret that jumps to the start
 * of the line the moment someone edits inside a link.
 */
function parseRun(
  text: string,
  start: number,
  stop: string | null,
  marks: readonly InlineMark[],
  base: number,
): Run {
  const spans: InlineSpan[] = [];
  let buffer = '';
  let bufferAt = start;
  let i = start;

  const add = (chars: string): void => {
    if (buffer.length === 0) bufferAt = i;
    buffer += chars;
  };
  const flush = (): void => {
    if (buffer.length === 0) return;
    // A literal run is verbatim by construction — escapes are pushed as their
    // own spans below — so its visible text maps to the source one for one.
    spans.push({
      text: buffer, marks: [...marks],
      start: base + bufferAt, end: base + i, textStart: base + bufferAt,
    });
    buffer = '';
  };

  while (i < text.length) {
    if (stop !== null && text.startsWith(stop, i)) {
      flush();
      return { spans, end: i + stop.length, closed: true };
    }

    const ch = text[i]!;

    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        // An escaped character becomes its own span so that every other literal
        // run stays a verbatim slice. One two-character span whose caret snaps
        // to an edge costs nothing; a run that is one character shorter than its
        // source costs every caret after it in the line.
        flush();
        spans.push({ text: next, marks: [...marks], start: base + i, end: base + i + 2 });
        i += 2;
        continue;
      }
      add(ch);
      i += 1;
      continue;
    }

    // Inline code first, and literal inside: backticks are what people reach
    // for precisely when they want the characters left alone.
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flush();
        spans.push({
          text: text.slice(i + 1, close), marks: withMark(marks, 'code'),
          start: base + i, end: base + close + 1, textStart: base + i + 1,
        });
        i = close + 1;
        continue;
      }
    }

    if (text.startsWith('[[', i)) {
      const close = text.indexOf(']]', i + 2);
      if (close > i + 1) {
        const title = unescapeInline(text.slice(i + 2, close)).trim();
        if (title.length > 0) {
          flush();
          spans.push({
            text: title, marks: [...marks], page: title,
            start: base + i, end: base + close + 2,
          });
          i = close + 2;
          continue;
        }
      }
    }

    // `@[label](uri)` before `[label](url)`, or the `@` would be prose and the
    // bracket would parse as an ordinary link — losing the mention entirely.
    if (ch === '@' && text[i + 1] === '[') {
      const link = readBracketLink(text, i + 1);
      if (link) {
        flush();
        spans.push(...labelSpans(link.label, marks, { mention: link.target }, base + i + 2, {
          start: base + i, end: base + link.end,
        }));
        i = link.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = readBracketLink(text, i);
      if (link) {
        flush();
        const attrs = isWorkspaceRefString(link.target)
          // A workspace URI written as an ordinary link is still a live
          // reference. Rendering it as a plain hyperlink would give the reader
          // a dead-looking address for something the app can resolve.
          ? { mention: link.target }
          : { href: link.target };
        spans.push(...labelSpans(link.label, marks, attrs, base + i + 1, {
          start: base + i, end: base + link.end,
        }));
        i = link.end;
        continue;
      }
    }

    // A bare `brainrouter://…` is a reference someone pasted. It is the same
    // thing the search index already treats as a reference (B5), so the
    // renderer should not be the one place that shows it as raw text.
    if (text.startsWith(WORKSPACE_REF_SCHEME, i)) {
      const uri = readBareUri(text, i);
      if (uri) {
        flush();
        spans.push({
          text: uri, marks: [...marks], mention: uri,
          start: base + i, end: base + i + uri.length,
        });
        i += uri.length;
        continue;
      }
    }

    const opened = openEmphasis(text, i, marks);
    if (opened) {
      const inner = parseRun(
        text, i + opened.delimiter.length, opened.delimiter,
        withMark(marks, opened.mark), base,
      );
      if (inner.closed) {
        flush();
        spans.push(...inner.spans);
        i = inner.end;
        continue;
      }
    }

    add(ch);
    i += 1;
  }

  flush();
  return { spans, end: i, closed: false };
}

function openEmphasis(
  text: string,
  i: number,
  marks: readonly InlineMark[],
): { mark: InlineMark; delimiter: string } | null {
  // `**` before `*`, or bold would parse as an italic containing an empty one.
  if (text.startsWith('**', i) && !marks.includes('bold')) return { mark: 'bold', delimiter: '**' };
  if (text.startsWith('~~', i) && !marks.includes('strike')) return { mark: 'strike', delimiter: '~~' };
  if (text[i] === '*' && !marks.includes('italic')) return { mark: 'italic', delimiter: '*' };
  return null;
}

function withMark(marks: readonly InlineMark[], mark: InlineMark): InlineMark[] {
  return marks.includes(mark) ? [...marks] : [...marks, mark];
}

/**
 * A link's label carries marks of its own, so it is parsed rather than taken flat.
 *
 * Every span it produces reports the range of the WHOLE construct, not of the
 * label inside it: a link is atomic to a caret, and a Backspace beside one
 * removes the link rather than the closing bracket of its target — which would
 * leave `[label](https://…` rendering as prose the person did not type.
 */
function labelSpans(
  label: string,
  marks: readonly InlineMark[],
  attrs: { href?: string; mention?: string },
  labelBase: number,
  construct: { start: number; end: number },
): InlineSpan[] {
  const inner = parseRun(label, 0, null, marks, labelBase).spans;
  const spans = inner.length > 0
    ? inner
    : [{ text: label, marks: [...marks], start: construct.start, end: construct.end }];
  return spans.map((span) => ({
    text: span.text,
    marks: span.marks,
    ...attrs,
    start: construct.start,
    end: construct.end,
  }));
}

interface BracketLink {
  label: string;
  target: string;
  /** Index just past the closing `)`. */
  end: number;
}

/** `[label](target)` starting at `open`, or null when it is not one. */
function readBracketLink(text: string, open: number): BracketLink | null {
  let i = open + 1;
  let label = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && ESCAPABLE.has(text[i + 1] ?? '')) {
      label += ch + text[i + 1];
      i += 2;
      continue;
    }
    // A nested `[` means this is not a link label; bailing keeps `[[page]]`
    // and stray brackets from being half-consumed.
    if (ch === '[') return null;
    if (ch === ']') break;
    label += ch;
    i += 1;
  }
  if (text[i] !== ']' || text[i + 1] !== '(') return null;

  i += 2;
  let target = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && ESCAPABLE.has(text[i + 1] ?? '')) {
      target += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === ')') break;
    // A newline inside a target means the `(` was prose that happened to follow
    // a bracket, several lines up.
    if (ch === '\n') return null;
    target += ch;
    i += 1;
  }
  if (text[i] !== ')') return null;
  if (target.trim().length === 0) return null;

  return { label, target: target.trim(), end: i + 1 };
}

/** How far a pasted `brainrouter://…` runs. Mirrors the search extractor's shape. */
function readBareUri(text: string, start: number): string | null {
  let end = start;
  while (end < text.length && !/[\s<>"'`]/.test(text[end]!)) end += 1;
  const uri = text.slice(start, end);
  return uri.length > WORKSPACE_REF_SCHEME.length ? uri : null;
}

/* ---------------------------------------------------------------- rendering */

/**
 * The text a reader sees, with every mark removed.
 *
 * Used for search snippets, the agent's bounded context (Q3) and the round-trip
 * property. A link contributes its label and a page link its title, because
 * that is what the person reads — showing the target would make every search
 * result about the URL rather than the sentence.
 */
export function inlinePlainText(text: string): string {
  return parseInlineMarks(text).map((span) => span.text).join('');
}

/** Every reference the inline syntax carries, canonically de-duplicated. */
export function inlineMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const span of parseInlineMarks(text)) if (span.mention) seen.add(span.mention);
  return [...seen].sort();
}

/** Every `[[page title]]` in the text, in reading order without repeats. */
export function inlinePageLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const span of parseInlineMarks(text)) if (span.page) seen.add(span.page);
  return [...seen];
}

/* --------------------------------------------------------------- authoring */

export interface MarkSelection {
  text: string;
  start: number;
  end: number;
}

/**
 * Toggle a mark over a selection — the keyboard shortcut, decided here.
 *
 * Idempotent by construction: applying it twice restores the exact string and
 * the exact selection. That is the property a shortcut needs and the one that
 * is easy to get wrong, because "wrap it" and "unwrap it" are usually written
 * as two functions and only the first is tested.
 *
 * An empty selection wraps nothing and leaves the caret between the delimiters,
 * so ⌘B before typing works the way people expect rather than doing nothing.
 */
export function toggleInlineMark(selection: MarkSelection, mark: InlineMark): MarkSelection {
  const { text } = selection;
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(Math.max(selection.end, start), start, text.length);
  const delimiter = MARK_DELIMITERS[mark];
  const width = delimiter.length;

  // Already wrapped from the OUTSIDE: `foo` selected inside `**foo**`.
  if (
    text.slice(start - width, start) === delimiter &&
    text.slice(end, end + width) === delimiter &&
    !straddlesLongerDelimiter(text, start, end, mark)
  ) {
    return {
      text: text.slice(0, start - width) + text.slice(start, end) + text.slice(end + width),
      start: start - width,
      end: end - width,
    };
  }

  // Already wrapped INSIDE the selection: `**foo**` selected whole.
  const selected = text.slice(start, end);
  if (
    selected.length >= width * 2 &&
    selected.startsWith(delimiter) &&
    selected.endsWith(delimiter) &&
    !(mark === 'italic' && selected.startsWith('**') && selected.endsWith('**'))
  ) {
    const inner = selected.slice(width, selected.length - width);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      start,
      end: start + inner.length,
    };
  }

  return {
    text: text.slice(0, start) + delimiter + selected + delimiter + text.slice(end),
    start: start + width,
    end: end + width,
  };
}

/**
 * Is the single `*` around this selection actually half of a `**`?
 *
 * Without this check, italic-toggling text that is already bold eats one
 * asterisk from each side and turns `**word**` into `*word*` — bold silently
 * becoming italic, from a keystroke that was meant to add something.
 */
function straddlesLongerDelimiter(text: string, start: number, end: number, mark: InlineMark): boolean {
  if (mark !== 'italic') return false;
  return text.slice(start - 2, start) === '**' && text.slice(end, end + 2) === '**';
}

/**
 * Write a link, a mention or a page link over a selection.
 *
 * One function rather than three, because the difference between them is which
 * syntax wraps the label — and three near-identical functions is how the
 * mention path ends up escaping its label and the link path does not.
 */
export function insertInlineLink(
  selection: MarkSelection,
  link: { target: string; label?: string; as?: 'link' | 'mention' | 'page' },
): MarkSelection {
  const { text } = selection;
  const start = clamp(selection.start, 0, text.length);
  const end = clamp(Math.max(selection.end, start), start, text.length);
  const label = (link.label ?? text.slice(start, end)).trim();
  const kind = link.as ?? (isWorkspaceRefString(link.target) ? 'mention' : 'link');

  const written = kind === 'page'
    ? `[[${escapeInline(label || link.target)}]]`
    : `${kind === 'mention' ? '@' : ''}[${escapeInline(label || link.target)}](${link.target})`;

  return {
    text: text.slice(0, start) + written + text.slice(end),
    start: start + written.length,
    end: start + written.length,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}
