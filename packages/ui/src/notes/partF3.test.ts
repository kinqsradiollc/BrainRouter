/**
 * ADR-029 F3/F4 — the judgements behind page-level undo, visual-row navigation,
 * templates and comments.
 *
 * What is pinned here is the half that cannot be seen by looking at the screen:
 * that ArrowUp from the middle of a WRAPPED paragraph stays in the block (the
 * defect F3 names), that ⌘Z reaches the page's stack the instant a block has no
 * typing left, that a refused undo is always said out loud, and that a comment
 * on a deleted block reads as something that survived rather than as a thread
 * about nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  atFirstVisualRow, atLastVisualRow, caretEntryPoint, mergeRowRects, visualRowIndex,
  type RowRect, type VisualRowGeometry,
} from './visualRows.js';
import { blockKeyIntent, type KeyLike } from './blockKeymap.js';
import { redoRoute, undoHighlightId, undoMenuLabel, undoNotice, undoRoute } from './pageUndo.js';
import {
  canPostComment, commentBadge, commentSections, commentThreadTitle, orphanedSectionTitle,
  orphanedThreadNote, resolveActionLabel, type NoteCommentDto,
} from './commentThread.js';
import {
  canBeTemplate, instantiationNote, templateActionLabel, templateRowHint, templatesEmptyNote,
} from './templates.js';
import { conflictLine } from './notesView.js';

/* ------------------------------------------------------------ visual rows */

const row = (top: number, height = 20, left = 0, right = 400): RowRect =>
  ({ top, bottom: top + height, left, right });

function geometry(rows: RowRect[], caretTop: number, left = 100): VisualRowGeometry {
  return { rows, caret: { top: caretTop, bottom: caretTop + 16, left } };
}

test('THE defect F3 names: the second row of a wrapped paragraph is not the first line', () => {
  // Three laid-out rows, no newline anywhere in the text. Part E's rule said
  // "first line" for every one of them, so ArrowUp left the block from the
  // middle of a paragraph and climbing it with the keyboard was impossible.
  const rows = [row(0), row(20), row(40)];
  assert.equal(visualRowIndex(geometry(rows, 22)), 1);
  assert.equal(atFirstVisualRow(geometry(rows, 22)), false);
  assert.equal(atLastVisualRow(geometry(rows, 22)), false);
});

test('the real edges still are edges', () => {
  const rows = [row(0), row(20), row(40)];
  assert.equal(atFirstVisualRow(geometry(rows, 2)), true);
  assert.equal(atLastVisualRow(geometry(rows, 2)), false);
  assert.equal(atLastVisualRow(geometry(rows, 42)), true);
  assert.equal(atFirstVisualRow(geometry(rows, 42)), false);
});

test('a block with nothing laid out is at both edges, so the caret is never trapped', () => {
  const empty = geometry([], 0);
  assert.equal(visualRowIndex(empty), -1);
  assert.equal(atFirstVisualRow(empty), true);
  assert.equal(atLastVisualRow(empty), true);
});

test('a caret between two line boxes lands on the nearer row rather than nowhere', () => {
  // line-height under 1 leaves a gap; refusing to answer would make the arrow
  // key inert, which is the failure the whole change exists to remove.
  const rows = [row(0, 14), row(20, 14)];
  const inGap = (top: number, bottom: number): VisualRowGeometry =>
    ({ rows, caret: { top, bottom, left: 40 } });
  assert.equal(visualRowIndex(inGap(14, 18)), 0, 'midpoint 16 is nearer the row ending at 14');
  assert.equal(visualRowIndex(inGap(16, 20)), 1, 'midpoint 18 is nearer the row starting at 20');
});

test('rects from marks and chips on one line merge back into one row', () => {
  // A range spanning elements reports a rect per element. Without merging, a
  // paragraph with a bold run would claim more rows than it has and ArrowUp
  // would refuse to leave a block the caret is at the top of.
  const merged = mergeRowRects([
    { top: 0, bottom: 20, left: 0, right: 80 },
    { top: 2, bottom: 18, left: 80, right: 140 },
    { top: 0, bottom: 0, left: 140, right: 140 },
    { top: 20, bottom: 40, left: 0, right: 60 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { top: 0, bottom: 20, left: 0, right: 140 });
});

test('a caret arriving from another block enters at the same x, clamped into the row', () => {
  const rows = [row(0, 20, 10, 300), row(20, 20, 10, 90)];
  assert.deepEqual(caretEntryPoint(rows, 'first', 200), { x: 200, y: 10 });
  // The last row is short: entering at x=200 would hit-test past its text.
  assert.deepEqual(caretEntryPoint(rows, 'last', 200), { x: 89, y: 30 });
  assert.deepEqual(caretEntryPoint(rows, 'last', 0), { x: 10, y: 30 });
  assert.equal(caretEntryPoint([], 'first', 5), null);
});

/* ------------------------------------------------- the keymap over layout */

const key = (over: Partial<KeyLike> = {}): KeyLike =>
  ({ key: 'ArrowUp', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over });

test('ArrowUp inside a wrapped paragraph is the browser’s, not the block’s', () => {
  const wrapped = 'a paragraph long enough to wrap over three rows with no newline in it at all';
  const intent = blockKeyIntent(key(), {
    text: wrapped,
    selection: { start: 40, end: 40 },
    kind: 'paragraph',
    geometry: geometry([row(0), row(20), row(40)], 22),
  });
  assert.equal(intent.kind, 'none', 'the caret climbs a row instead of leaving the block');
});

test('ArrowUp on the first visual row leaves the block and carries the x', () => {
  const intent = blockKeyIntent(key(), {
    text: 'wrapped text',
    selection: { start: 3, end: 3 },
    kind: 'paragraph',
    geometry: geometry([row(0), row(20)], 2, 137),
  });
  assert.equal(intent.kind, 'caret-up');
  assert.equal(intent.kind === 'caret-up' ? intent.x : null, 137);
});

test('without a layout the newline rule is what happens, deliberately', () => {
  // The browser dev harness before first paint. Part E's behaviour is the right
  // thing to degrade to: wrong for a wrapped paragraph, right for everything
  // else, and never inert.
  const intent = blockKeyIntent(key(), {
    text: 'one\ntwo',
    selection: { start: 5, end: 5 },
    kind: 'paragraph',
  });
  assert.equal(intent.kind, 'none', 'there is a newline above the caret, so this is not the first line');

  const top = blockKeyIntent(key(), { text: 'one\ntwo', selection: { start: 1, end: 1 }, kind: 'paragraph' });
  assert.equal(top.kind, 'caret-up');
  assert.equal(top.kind === 'caret-up' ? top.x : 'absent', undefined);
});

test('the block-moving chord still wins over the caret, wrapped or not', () => {
  const intent = blockKeyIntent(key({ metaKey: true, shiftKey: true }), {
    text: 'wrapped',
    selection: { start: 40, end: 40 },
    kind: 'paragraph',
    geometry: geometry([row(0), row(20), row(40)], 22),
  });
  assert.equal(intent.kind, 'move-up');
});

/* -------------------------------------------------------------- page undo */

test('⌘Z takes the block’s typing first and the page’s the moment there is none', () => {
  assert.equal(undoRoute({ blockHasHistory: true }), 'text');
  assert.equal(undoRoute({ blockHasHistory: false }), 'page');
  assert.equal(redoRoute({ blockHasFuture: true }), 'text');
  assert.equal(redoRoute({ blockHasFuture: false }), 'page');
});

test('a successful undo says nothing; every refusal says something', () => {
  assert.equal(undoNotice({ ok: true, label: 'the edit' }), null);
  assert.match(undoNotice({ ok: false, reason: 'nothing_to_undo' }) ?? '', /nothing left to undo/i);
  assert.equal(
    undoNotice({ ok: false, reason: 'remote_change', detail: 'another device has changed one of these blocks' }),
    'another device has changed one of these blocks',
  );
  // A dropped answer is still a refusal, not a silent success — "⌘Z did
  // nothing" is the exact failure F4 exists to remove.
  assert.equal(undoNotice(null), 'That could not be undone.');
});

test('a refusal points at the block it is about', () => {
  assert.equal(undoHighlightId({ ok: false, reason: 'remote_change', blockId: 'blk_9' }), 'blk_9');
  assert.equal(undoHighlightId({ ok: true, focusId: 'blk_9' }), null);
});

test('the menu entry names what it would take back, or says it can take nothing', () => {
  assert.equal(undoMenuLabel('splitting the block', 'undo'), 'Undo splitting the block');
  assert.equal(undoMenuLabel(null, 'redo'), 'Nothing to redo');
});

/* --------------------------------------------------------------- comments */

const comment = (id: string, over: Partial<NoteCommentDto> = {}): NoteCommentDto => ({
  id, body: `body ${id}`, author: 'Ada', resolved: false, createdAtMs: 1, ...over,
});

test('a thread reads forwards and keeps what was settled', () => {
  const sections = commentSections([
    comment('c', { createdAtMs: 30 }),
    comment('a', { createdAtMs: 10 }),
    comment('b', { createdAtMs: 20, resolved: true }),
  ]);
  assert.deepEqual(sections.open.map((one) => one.id), ['a', 'c']);
  assert.deepEqual(sections.resolved.map((one) => one.id), ['b']);
});

test('the badge leads with what is still open, so one live remark is not buried', () => {
  const nine = Array.from({ length: 9 }, (_, at) => comment(`r${at}`, { resolved: true, createdAtMs: at }));
  assert.equal(commentBadge([...nine, comment('open', { createdAtMs: 99 })]), '1');
  assert.equal(commentBadge(nine), '9 resolved');
  assert.equal(commentBadge([]), null);
});

test('the thread title says the state rather than only the count', () => {
  assert.equal(commentThreadTitle([]), 'No comments yet');
  assert.equal(commentThreadTitle([comment('a')]), '1 comment');
  assert.equal(commentThreadTitle([comment('a', { resolved: true })]), '1 comment, resolved');
  assert.equal(commentThreadTitle([comment('a'), comment('b', { resolved: true })]), '1 open of 2');
});

test('an empty comment is not postable, and the action names the direction', () => {
  assert.equal(canPostComment('   \n '), false);
  assert.equal(canPostComment(' something '), true);
  assert.equal(resolveActionLabel(false), 'Resolve');
  assert.equal(resolveActionLabel(true), 'Reopen');
});

test('C5 — a comment whose block was deleted reads as something that survived', () => {
  const note = orphanedThreadNote({
    blockId: 'blk_1',
    text: 'the number in this row is wrong',
    comments: [comment('a'), comment('b', { resolved: true })],
  });
  assert.match(note, /was deleted/);
  assert.match(note, /comments are here either way/);
  assert.match(note, /the number in this row is wrong/);

  // A block with no text still gets a sentence: the thread must never appear to
  // be about nothing.
  assert.match(orphanedThreadNote({ blockId: 'b', text: '   ', comments: [comment('a')] }), /a block with no text/);
  assert.equal(orphanedSectionTitle([]), null);
});

test('a kept-both COMMENT says so, rather than accusing the paragraph', () => {
  // The same reason arrives for a block's prose and for a comment on it. Without
  // the distinction the banner claims a paragraph nobody touched was written
  // twice, which is how people learn to dismiss the banner that matters.
  assert.match(
    conflictLine({
      field: 'comment:cmt_9', reason: 'concurrent_text',
      oursAt: { physical: 1, logical: 0, deviceId: 'ours' },
      theirsAt: { physical: 1, logical: 0, deviceId: 'theirs' },
    }),
    /^A comment on this block/,
  );
  assert.match(conflictLine({
    field: 'text', reason: 'concurrent_text',
    oursAt: { physical: 1, logical: 0, deviceId: 'ours' },
    theirsAt: { physical: 1, logical: 0, deviceId: 'theirs' },
  }), /^Written in two places/);
});

/* -------------------------------------------------------------- templates */

test('only a container can be a template', () => {
  assert.equal(canBeTemplate('page'), true);
  assert.equal(canBeTemplate('database'), true);
  assert.equal(canBeTemplate('paragraph'), false);
  assert.equal(templateActionLabel(false), 'Save as a template');
  assert.equal(templateActionLabel(true), 'Stop using as a template');
});

test('the picker says what you get, and how to make the list non-empty', () => {
  assert.equal(templateRowHint({ id: 'p', title: 'Plan', icon: null, blocks: 1 }), 'An empty page');
  assert.equal(templateRowHint({ id: 'p', title: 'Plan', icon: null, blocks: 12 }), '12 blocks');
  assert.match(templatesEmptyNote(), /Save as a template/);
});

test('the sentence about rewritten references is core’s, and only defaulted when absent', () => {
  assert.equal(instantiationNote('New page from the template — 4 blocks.'), 'New page from the template — 4 blocks.');
  assert.equal(instantiationNote(''), 'New page from the template.');
  assert.equal(instantiationNote(null), 'New page from the template.');
});
