/**
 * ADR-029 E1 — the dozen key presses the parity test is actually about.
 *
 * "A person who uses one of these apps can type a page here without being
 * taught anything" is decided by whether Enter splits, Backspace at column zero
 * merges, Tab nests and the arrows leave the block at its edges. Each of those
 * is asserted here rather than discovered by typing, because the failures are
 * quiet: a Tab that does nothing looks like a focus bug, and a Backspace that
 * merges from column three deletes a word every time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockKeyIntent, stopsWindowShortcut, type BlockKeyContext, type KeyLike } from './blockKeymap.js';

const key = (over: Partial<KeyLike> & { key: string }): KeyLike =>
  ({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over });

const ctx = (over: Partial<BlockKeyContext> = {}): BlockKeyContext => ({
  text: 'a line', selection: { start: 3, end: 3 }, kind: 'paragraph', ...over,
});

test('Enter splits, Shift-Enter does not, and Enter inside code is a newline', () => {
  assert.equal(blockKeyIntent(key({ key: 'Enter' }), ctx()).kind, 'split');
  assert.equal(blockKeyIntent(key({ key: 'Enter', shiftKey: true }), ctx()).kind, 'newline');
  // Code is verbatim: a newline in it is a newline. Core refuses the split for
  // the same reason, so this only saves the round trip.
  assert.equal(blockKeyIntent(key({ key: 'Enter' }), ctx({ kind: 'code' })).kind, 'newline');
});

test('Backspace merges only at column zero, and only with nothing selected', () => {
  assert.equal(blockKeyIntent(key({ key: 'Backspace' }), ctx({ selection: { start: 0, end: 0 } })).kind, 'merge-back');
  assert.equal(blockKeyIntent(key({ key: 'Backspace' }), ctx({ selection: { start: 2, end: 2 } })).kind, 'none');
  // A selection that happens to start at zero is a deletion, not a merge.
  assert.equal(blockKeyIntent(key({ key: 'Backspace' }), ctx({ selection: { start: 0, end: 3 } })).kind, 'none');
});

test('Tab nests and Shift-Tab lifts out', () => {
  assert.equal(blockKeyIntent(key({ key: 'Tab' }), ctx()).kind, 'indent');
  assert.equal(blockKeyIntent(key({ key: 'Tab', shiftKey: true }), ctx()).kind, 'outdent');
});

test('the arrows leave the block at its edges, carrying the column with them', () => {
  const first = blockKeyIntent(key({ key: 'ArrowUp' }), ctx({ text: 'abcdef', selection: { start: 4, end: 4 } }));
  assert.deepEqual(first, { kind: 'caret-up', column: 4 });
  // Inside a multi-line block the arrow belongs to the browser: moving between
  // the block's own lines is not a gesture we implement.
  assert.equal(
    blockKeyIntent(key({ key: 'ArrowUp' }), ctx({ text: 'one\ntwo', selection: { start: 5, end: 5 } })).kind,
    'none',
  );
  assert.equal(
    blockKeyIntent(key({ key: 'ArrowDown' }), ctx({ text: 'one', selection: { start: 3, end: 3 } })).kind,
    'caret-down',
  );
});

test('Shift-arrow past the edge selects blocks; the modifier moves the block itself', () => {
  assert.equal(blockKeyIntent(key({ key: 'ArrowUp', shiftKey: true }), ctx({ text: 'x', selection: { start: 0, end: 0 } })).kind, 'select-up');
  assert.equal(blockKeyIntent(key({ key: 'ArrowUp', metaKey: true, shiftKey: true }), ctx()).kind, 'move-up');
  assert.equal(blockKeyIntent(key({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }), ctx()).kind, 'move-down');
});

test('the mark shortcuts work with either modifier, because one build runs on both platforms', () => {
  assert.deepEqual(blockKeyIntent(key({ key: 'b', metaKey: true }), ctx()), { kind: 'toggle-mark', mark: 'bold' });
  assert.deepEqual(blockKeyIntent(key({ key: 'i', ctrlKey: true }), ctx()), { kind: 'toggle-mark', mark: 'italic' });
  assert.deepEqual(blockKeyIntent(key({ key: 'e', metaKey: true }), ctx()), { kind: 'toggle-mark', mark: 'code' });
  assert.deepEqual(
    blockKeyIntent(key({ key: 's', metaKey: true, shiftKey: true }), ctx()),
    { kind: 'toggle-mark', mark: 'strike' },
  );
});

test('⌘K writes a link when something is selected, and is quick find when nothing is', () => {
  assert.equal(blockKeyIntent(key({ key: 'k', metaKey: true }), ctx({ selection: { start: 0, end: 4 } })).kind, 'link');
  const empty = blockKeyIntent(key({ key: 'k', metaKey: true }), ctx());
  assert.equal(empty.kind, 'none');
  assert.equal(stopsWindowShortcut(empty), false, 'quick find must still open');
});

test('an open menu owns the arrows and Enter', () => {
  // Otherwise the caret moves out from under the menu the person is choosing
  // from, and Enter splits the block instead of picking a command.
  const menu = ctx({ menuOpen: true });
  for (const k of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab']) {
    assert.equal(blockKeyIntent(key({ key: k }), menu).kind, 'none');
  }
  assert.equal(blockKeyIntent(key({ key: 'Escape' }), menu).kind, 'escape');
});

test('an input method owns the keyboard until it is finished', () => {
  // Enter during a composition means "accept this candidate", and splitting the
  // block there loses the characters that were being composed.
  assert.equal(blockKeyIntent(key({ key: 'Enter' }), ctx({ composing: true })).kind, 'none');
});
