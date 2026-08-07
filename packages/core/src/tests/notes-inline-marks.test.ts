/**
 * ADR-029 E2 — marks stored in the string, and the round trip that makes that
 * safe.
 *
 * The headline test is the escaping one. E2 accepts a known, visible, local
 * problem (a literal `*` needs escaping) in exchange for refusing a silent
 * corruption (two fields that disagree about offsets after a concurrent edit).
 * That trade is only worth taking if the escaping is actually reversible, so
 * the round trip is pinned over a corpus of exactly the characters the syntax
 * uses — not over prose that happens not to contain any.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeInline, inlineMentions, inlinePageLinks, inlinePlainText,
  insertInlineLink, parseInlineMarks, toggleInlineMark, unescapeInline,
} from '../notes/inlineMarks.js';

/* ------------------------------------------------------------- round trip */

const LITERALS = [
  'a * b',
  '**not bold**',
  'shell: rm -rf ~~/tmp~~',
  'backtick ` and ``double``',
  '[not a link](either)',
  '[[not a page]]',
  'email me @someone',
  'C:\\Users\\notes\\draft.md',
  'a \\* b',
  'markdown: *_~`[]()@\\',
  '100% of 5*4 = 20',
  '',
  'plain sentence with nothing special in it',
];

test('a literal a person typed survives escape → parse → plain text, exactly', () => {
  for (const raw of LITERALS) {
    const round = inlinePlainText(escapeInline(raw));
    assert.equal(round, raw, `round trip changed ${JSON.stringify(raw)} into ${JSON.stringify(round)}`);
  }
});

test('unescape is the exact inverse of escape, with no parsing in between', () => {
  for (const raw of LITERALS) {
    assert.equal(unescapeInline(escapeInline(raw)), raw);
  }
});

test('a lone backslash stays a backslash rather than eating the next character', () => {
  // Without this, a Windows path in prose loses a character per separator and
  // the person cannot tell whether they mistyped it.
  assert.equal(inlinePlainText('C:\\Users\\x'), 'C:\\Users\\x');
});

/* ----------------------------------------------------------------- parsing */

test('the four marks parse, and nest', () => {
  const spans = parseInlineMarks('**bold *and italic* still bold**');
  assert.deepEqual(spans.map((s) => s.text), ['bold ', 'and italic', ' still bold']);
  assert.deepEqual([...spans[0]!.marks], ['bold']);
  assert.deepEqual([...spans[1]!.marks], ['bold', 'italic']);
});

test('inline code is literal inside — the one thing backticks are for', () => {
  const spans = parseInlineMarks('run `npm **run** build` now');
  const code = spans.find((s) => s.marks.includes('code'))!;
  assert.equal(code.text, 'npm **run** build', 'marks inside code must not be interpreted');
});

test('an unclosed delimiter is text, because it is a half-typed one', () => {
  // Mid-typing, `**bo` has to render as the characters that are there. Anything
  // else makes the rest of the paragraph flicker as someone types.
  assert.equal(inlinePlainText('**bo'), '**bo');
  assert.deepEqual(parseInlineMarks('**bo')[0]!.marks, []);
});

test('a link carries its target and shows its label', () => {
  const spans = parseInlineMarks('see [the docs](https://example.test/x) please');
  const link = spans.find((s) => s.href)!;
  assert.equal(link.text, 'the docs');
  assert.equal(link.href, 'https://example.test/x');
  assert.equal(inlinePlainText('see [the docs](https://example.test/x) please'), 'see the docs please');
});

test('an @-mention of a workspace reference is a mention, not a hyperlink', () => {
  const text = '@[BR-114](brainrouter://track/work-item/BR-114) is blocked';
  const span = parseInlineMarks(text).find((s) => s.mention)!;
  assert.equal(span.mention, 'brainrouter://track/work-item/BR-114');
  assert.equal(span.href, undefined, 'a live reference must not render as a dead URL');
  assert.deepEqual(inlineMentions(text), ['brainrouter://track/work-item/BR-114']);
});

test('a workspace URI written as an ordinary link is still a live reference (A3)', () => {
  const span = parseInlineMarks('[a task](brainrouter://planner/item/itm_1)').find((s) => s.mention);
  assert.ok(span, 'the app can resolve this — showing it as a plain hyperlink would waste that');
  assert.equal(span!.href, undefined);
});

test('a pasted bare reference is recognised, the same as the search index sees it (B5)', () => {
  const text = 'context: brainrouter://notes/block/blk_9 and more';
  assert.deepEqual(inlineMentions(text), ['brainrouter://notes/block/blk_9']);
});

test('[[page links]] parse to a title the caller resolves', () => {
  assert.deepEqual(inlinePageLinks('see [[Release checklist]] and [[Release checklist]]'), ['Release checklist']);
  assert.equal(inlinePlainText('see [[Release checklist]]'), 'see Release checklist');
});

/* -------------------------------------------------------- source ranges */

test('every span says where it came from, so a rendered caret maps back to the string', () => {
  // E2 keeps the marks IN the text, which means an editor showing the rendered
  // form has to answer "the caret is here on screen — where is that in the
  // string?" per keystroke. A second scanner in the renderer would answer it
  // differently, and one character off is a caret that lands inside a delimiter.
  const text = 'a **bold** b';
  for (const span of parseInlineMarks(text)) {
    assert.ok(span.end > span.start, 'a span with no range cannot be mapped back');
    if (span.textStart !== undefined) {
      assert.equal(
        text.slice(span.textStart, span.textStart + span.text.length),
        span.text,
        'textStart promises the visible text is a verbatim slice',
      );
    }
  }
});

test('a literal run stays verbatim, and an escape is its own span rather than shortening one', () => {
  // Without the split, `a \* b` would be one span whose visible text is a
  // character shorter than its source — and every caret after it in the line
  // would be off by one.
  const spans = parseInlineMarks('a \\* b');
  assert.equal(spans.map((s) => s.text).join(''), 'a * b');
  const escaped = spans.find((s) => s.textStart === undefined)!;
  assert.equal(escaped.text, '*');
  assert.equal(escaped.end - escaped.start, 2, 'the escape covers both characters it was written with');
});

test('a link is atomic: every span of it reports the whole construct, not the label', () => {
  const text = 'see [the **docs**](https://example.test/x)';
  const spans = parseInlineMarks(text).filter((s) => s.href);
  assert.ok(spans.length >= 1);
  for (const span of spans) {
    assert.equal(text.slice(span.start, span.end), '[the **docs**](https://example.test/x)');
    assert.equal(span.textStart, undefined, 'a caret cannot sit inside something whose visible form is not the source');
  }
});

/* --------------------------------------------------------------- authoring */

test('toggling a mark twice restores the exact string AND the exact selection', () => {
  // The property a keyboard shortcut needs. "Wrap" and "unwrap" are usually two
  // functions and only the first gets tested.
  const start = { text: 'make this bold', start: 10, end: 14 };
  const bolded = toggleInlineMark(start, 'bold');
  assert.equal(bolded.text, 'make this **bold**');
  assert.equal(bolded.text.slice(bolded.start, bolded.end), 'bold');

  const back = toggleInlineMark(bolded, 'bold');
  assert.deepEqual(back, start);
});

test('toggling italic over bold text does not eat one asterisk from each side', () => {
  // Without the guard this turns `**word**` into `*word*` — bold silently
  // becoming italic from a keystroke meant to add something.
  const bold = { text: '**word**', start: 2, end: 6 };
  const both = toggleInlineMark(bold, 'italic');
  assert.equal(both.text, '**\*word\***');
  assert.deepEqual([...parseInlineMarks(both.text)[0]!.marks], ['bold', 'italic']);
});

test('toggling a whole selection that already carries the marks strips them', () => {
  const selected = { text: 'a ~~gone~~ b', start: 2, end: 10 };
  const plain = toggleInlineMark(selected, 'strike');
  assert.equal(plain.text, 'a gone b');
  assert.equal(plain.text.slice(plain.start, plain.end), 'gone');
});

test('an empty selection wraps nothing and leaves the caret between the delimiters', () => {
  const caret = { text: 'ab', start: 1, end: 1 };
  const wrapped = toggleInlineMark(caret, 'code');
  assert.equal(wrapped.text, 'a``b');
  assert.equal(wrapped.start, 2);
  assert.equal(wrapped.end, 2);
});

test('inserting a workspace reference writes a mention without being told to', () => {
  const written = insertInlineLink(
    { text: 'blocked by ', start: 11, end: 11 },
    { target: 'brainrouter://track/work-item/BR-114', label: 'BR-114' },
  );
  assert.equal(written.text, 'blocked by @[BR-114](brainrouter://track/work-item/BR-114)');
  assert.deepEqual(inlineMentions(written.text), ['brainrouter://track/work-item/BR-114']);
});

test('a label with syntax in it is escaped on the way in, so it round-trips out', () => {
  const written = insertInlineLink(
    { text: '', start: 0, end: 0 },
    { target: 'https://example.test', label: 'the *starred* one' },
  );
  assert.equal(inlinePlainText(written.text), 'the *starred* one');
});
