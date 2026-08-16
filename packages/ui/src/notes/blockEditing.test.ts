/**
 * ADR-029 E1/E2 — the caret, which is the feature.
 *
 * E1 is judged by typing: a gesture that works but drops the caret to the start
 * of the document fails the parity test as surely as one that does nothing. So
 * these tests are almost all about WHERE THE CARET ENDS UP, and the mapping
 * between the string a block stores and the text a person sees is pinned in both
 * directions — because a mapping that is right one way and approximate the other
 * puts the caret one character off in exactly the paragraphs that use marks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backspaceEdit, caretForColumn, columnOf, deleteForwardEdit, EMPTY_HISTORY, inlineSegments,
  inputRuleStillApplies, isOnFirstLine, isOnLastLine, nextBoundary, previousBoundary,
  recordEdit, redoEdit, reduceComposition, replaceRange, sourceToVisible, textToShow,
  undoEdit, visibleTextOf, visibleToSource, type CompositionState,
} from './blockEditing.js';

/* ------------------------------------------------------------- the mapping */

test('the rendered text is the source without its delimiters', () => {
  const segments = inlineSegments('a **bold** and `code` here');
  assert.equal(visibleTextOf(segments), 'a bold and code here');
});

test('a caret maps to the rendered text and back to the same source offset', () => {
  const source = 'a **bold** end';
  const segments = inlineSegments(source);
  // Every offset that has a rendered position must survive the round trip;
  // offsets inside a delimiter have none, which is why they are skipped.
  for (const at of [0, 1, 2, 5, 6, 10, 12, source.length]) {
    const visible = sourceToVisible(segments, at);
    const back = visibleToSource(segments, visible);
    assert.equal(sourceToVisible(segments, back), visible, `offset ${at} did not settle`);
  }
});

test('a click inside a rendered link puts the caret beside it, never inside the target', () => {
  const source = 'see [the docs](https://example.test/x) now';
  const segments = inlineSegments(source);
  const visible = visibleTextOf(segments);
  assert.equal(visible, 'see the docs now');
  // Halfway through the words "the docs" on screen.
  const inside = visibleToSource(segments, visible.indexOf('the docs') + 4);
  assert.ok(
    inside === source.indexOf('[the docs]') || inside === source.indexOf(')') + 1,
    'the caret landed inside a URL the reader cannot see',
  );
});

test('an offset inside a delimiter resolves to an edge rather than refusing to answer', () => {
  const segments = inlineSegments('**bold**');
  // Between the two stars: no rendered position exists. A caret with nowhere to
  // go after an edit that landed there is a lost keystroke.
  const visible = sourceToVisible(segments, 1);
  assert.ok(visible >= 0 && visible <= 4);
});

/* ------------------------------------------------------------------ edits */

test('typed text goes in raw, so typing markdown still produces marks', () => {
  // Escaping what a person typed would mean `**bold**` could never be reached
  // from the keyboard — the one gesture E1 says has to work.
  const edit = replaceRange('a b', { start: 2, end: 2 }, '**x**');
  assert.equal(edit.text, 'a **x**b');
  assert.equal(edit.caret, 7);
});

test('backspace at column zero belongs to the block above, and says so', () => {
  assert.equal(backspaceEdit('text', { start: 0, end: 0 }), null);
  const inside = backspaceEdit('text', { start: 2, end: 2 })!;
  assert.equal(inside.text, 'txt');
  assert.equal(inside.caret, 1);
});

test('backspace beside a mention removes the whole reference, not one character of its target', () => {
  // A half-deleted `@[label](brainrouter://…` renders as prose nobody typed,
  // and the reference it used to be is unrecoverable from what is left.
  const source = 'blocked by @[BR-114](brainrouter://track/work-item/BR-114)';
  const edit = backspaceEdit(source, { start: source.length, end: source.length })!;
  assert.equal(edit.text, 'blocked by ');
  assert.equal(edit.caret, 11);
});

test('backspace deletes one CHARACTER, not one UTF-16 unit', () => {
  // Deleting half of an emoji leaves a different emoji on screen from the one
  // the person was looking at, which reads as the app mangling their text.
  const waving = 'hi 👋🏽';
  const edit = backspaceEdit(waving, { start: waving.length, end: waving.length })!;
  assert.equal(edit.text, 'hi ');
  assert.equal(previousBoundary('é', 2), 0, 'a combining accent belongs to its letter');
  assert.equal(nextBoundary('éx', 0), 2);
});

test('a selection is replaced by what was typed over it', () => {
  const edit = replaceRange('keep this bit', { start: 5, end: 9 }, 'that');
  assert.equal(edit.text, 'keep that bit');
  assert.equal(edit.caret, 9);
});

test('forward delete at the end of a block has nothing to take', () => {
  assert.equal(deleteForwardEdit('abc', { start: 3, end: 3 }), null);
  assert.equal(deleteForwardEdit('abc', { start: 1, end: 1 })!.text, 'ac');
});

/* ------------------------------------------------------------ line motion */

test('the arrows leave the block only at its first and last line', () => {
  const two = 'one\ntwo';
  assert.equal(isOnFirstLine(two, 1), true);
  assert.equal(isOnFirstLine(two, 5), false);
  assert.equal(isOnLastLine(two, 5), true);
  assert.equal(isOnLastLine(two, 1), false);
});

test('a caret arriving from another block keeps its column, clamped to the line', () => {
  assert.equal(columnOf('one\ntwenty', 8), 4);
  assert.equal(caretForColumn('abcdef', 3, 'first'), 3);
  // Landing in the middle of a word two lines down is not "the same column".
  assert.equal(caretForColumn('ab\ncd', 9, 'last'), 5);
  assert.equal(caretForColumn('ab\ncd', 1, 'first'), 1);
});

/* --------------------------------------------------- what the editor shows */

test('a focused block keeps its draft, because the store answers several keystrokes late', () => {
  // Adopting the echo mid-sentence would drop keystrokes AND move the caret,
  // which is the most destructive thing an editor can do.
  const focused = textToShow({ incoming: 'old', draft: 'old and new', focused: true, lastPushed: 'old' });
  assert.equal(focused, 'old and new');
});

test('an unfocused block shows what arrived, unless it is our own write echoed back', () => {
  assert.equal(
    textToShow({ incoming: 'theirs', draft: 'mine', focused: false, lastPushed: 'ours' }),
    'theirs',
  );
  assert.equal(
    textToShow({ incoming: 'ours', draft: 'mine', focused: false, lastPushed: 'ours' }),
    'mine',
  );
});

test('the head of a split takes the store\'s answer, even though it still has focus', () => {
  // Enter at offset 3 of "second line". The store now holds ["sec", "ond line"]
  // and reports the truncation while the caret is still in the head — the tail
  // only takes focus once the split has resolved. Kept out by the focused rule,
  // this answer is never offered again: the head shows the whole line for the
  // rest of the session and the next keystroke in it pushes the pre-split text
  // back over the split, leaving the tail duplicated for good.
  assert.equal(
    textToShow({
      incoming: 'sec', draft: 'second line', focused: true, lastPushed: 'second line', expected: 'sec',
    }),
    'sec',
  );
});

test('an outstanding split does not hand a focused block anything ELSE the store says', () => {
  // The expectation recognises one answer. Another device's write, or a stale
  // read landing late, is still the thing a focused block must refuse — it
  // would drop the keystrokes in the draft and move the caret.
  assert.equal(
    textToShow({
      incoming: 'from another device', draft: 'second line',
      focused: true, lastPushed: 'second line', expected: 'sec',
    }),
    'second line',
  );
  // And core answers Enter differently for a table row, a code block and an
  // empty list item: the text does not change, nothing matches, nothing moves.
  assert.equal(
    textToShow({
      incoming: 'second line', draft: 'second line',
      focused: true, lastPushed: 'second line', expected: 'sec',
    }),
    'second line',
  );
});

test('an input rule that missed its moment does nothing', () => {
  // The rule is decided in core through the host, so the answer arrives after a
  // round trip a person can type into. Applying it late would overwrite the
  // character they typed with the tail the marker left behind.
  assert.equal(inputRuleStillApplies('# ', '# '), true);
  assert.equal(inputRuleStillApplies('# ', '# H'), false);
});

/* ---------------------------------------------------------------- undo */

test('a run of typing undoes as one edit, not one character at a time', () => {
  // Per-keystroke undo is worse than none: the person has to guess how many
  // times to press it. The run is detected structurally, so it behaves the same
  // on a fast machine and a slow one.
  let history = EMPTY_HISTORY;
  let state = { text: 'a', caret: 1 };
  for (const ch of 'bcd') {
    const next = { text: state.text + ch, caret: state.caret + 1 };
    history = recordEdit(history, state, next);
    state = next;
  }
  assert.equal(state.text, 'abcd');
  assert.equal(history.past.length, 1, 'the run should be one entry');

  const undone = undoEdit(history, state)!;
  assert.equal(undone.edit.text, 'a');
  const redone = redoEdit(undone.history, undone.edit)!;
  assert.equal(redone.edit.text, 'abcd', 'redo must put back exactly what undo took');
});

test('a new edit abandons the redo branch', () => {
  // Otherwise ⌘⇧Z replays something that never happened after it.
  let history = recordEdit(EMPTY_HISTORY, { text: '', caret: 0 }, { text: 'one', caret: 3 });
  const undone = undoEdit(history, { text: 'one', caret: 3 })!;
  history = recordEdit(undone.history, undone.edit, { text: 'two', caret: 3 });
  assert.equal(history.future.length, 0);
  assert.equal(redoEdit(history, { text: 'two', caret: 3 }), null);
});

test('undo on an untouched block does nothing rather than clearing it', () => {
  assert.equal(undoEdit(EMPTY_HISTORY, { text: 'kept', caret: 0 }), null);
});

/* ------------------------------------------------------- IME composition */

test('a composition session commits exactly once, with the finished text', () => {
  // The half-composed reading — what a Japanese or Korean typist sees before
  // choosing a candidate — must never reach the document, or the sentence
  // rewrites itself as it is typed.
  let state: CompositionState = null;
  const commits: string[] = [];
  const feed = (event: Parameters<typeof reduceComposition>[1]): void => {
    const step = reduceComposition(state, event);
    state = step.state;
    if (step.commit) commits.push(step.commit.text);
  };

  feed({ type: 'start', source: 'hello ', nodeStart: 0, nodeEnd: 6, before: 'hello ' });
  feed({ type: 'update' });
  feed({ type: 'update' });
  feed({ type: 'end', after: 'hello 世界' });

  assert.deepEqual(commits, ['hello 世界']);
  assert.equal(state, null, 'the session must not survive its own end');
});

test('a composition that ends without having started commits nothing', () => {
  // A blur cancels a composition and the stray event still arrives. Reacting to
  // it would write the same characters a second time.
  const step = reduceComposition(null, { type: 'end', after: 'ignored' });
  assert.equal(step.commit, undefined);
  assert.equal(step.state, null);
});

test('a composition commits into the middle of a block, not over it', () => {
  const step = reduceComposition(
    { source: 'a  b', nodeStart: 2, nodeEnd: 2, before: '' },
    { type: 'end', after: 'ねこ' },
  );
  assert.equal(step.commit!.text, 'a ねこ b');
  assert.equal(step.commit!.caret, 4);
});
