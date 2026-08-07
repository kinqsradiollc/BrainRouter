/**
 * ADR-029 E1 — the gestures, over the real store.
 *
 * These run against `noteStore` rather than a fake, deliberately: the claim
 * being tested is not "split computes two strings" but "split goes through the
 * one write path, so a lease can refuse it and the outbox carries it". A test
 * against a stub would pass with a second write path in place, which is the
 * thing most worth catching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  duplicateBlock, indentBlock, mergeIntoPrevious, moveBlockDown, moveBlockUp,
  outdentBlock, splitBlock,
} from '../notes/blockOps.js';
import {
  beginEditing, createBlock, getBlock, listBlocks, noteTree, readNotes, updateBlock,
  writeNotes,
} from '../notes/noteStore.js';
import { buildNoteTree } from '../notes/noteTree.js';

const T = Date.parse('2026-08-07T09:00:00.000Z');

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-notes-ops-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(dir, { recursive: true, force: true });
}

/** Reading order, which is what every one of these gestures is expressed in. */
function order(): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof buildNoteTree>['roots']): void => {
    for (const node of nodes) { out.push(node.block.text.value); walk(node.children); }
  };
  walk(noteTree(undefined).roots);
  return out;
}

/* ------------------------------------------------------------------- split */

test('Enter splits a block at the caret and leaves the caret in the second half', () => {
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'one two' }, T);
    const result = splitBlock(undefined, block.id, 3, T + 1);

    assert.ok(result.ok);
    assert.equal(result.action, 'split');
    assert.equal(getBlock(undefined, block.id)?.text.value, 'one');
    assert.equal(getBlock(undefined, result.createdId!)?.text.value, ' two');
    assert.equal(result.focusId, result.createdId);
    assert.equal(result.caret, 0);
    assert.deepEqual(order(), ['one', ' two']);
  } finally { cleanup(dir); }
});

test('a list continues itself; a heading does not', () => {
  const dir = home();
  try {
    const bullet = createBlock(undefined, { kind: 'bullet', text: 'first' }, T);
    const afterBullet = splitBlock(undefined, bullet.id, 5, T + 1);
    assert.ok(afterBullet.ok);
    assert.equal(getBlock(undefined, afterBullet.createdId!)?.kind.value, 'bullet');

    const heading = createBlock(undefined, { kind: 'heading', text: 'Section', level: 2 }, T + 2);
    const afterHeading = splitBlock(undefined, heading.id, 7, T + 3);
    assert.ok(afterHeading.ok);
    assert.equal(
      getBlock(undefined, afterHeading.createdId!)?.kind.value,
      'paragraph',
      'splitting a heading into two headings is the classic naive-editor bug',
    );
  } finally { cleanup(dir); }
});

test('Enter on an empty nested list item lifts it out instead of making another', () => {
  // The only way out of a list without reaching for the mouse.
  const dir = home();
  try {
    const parent = createBlock(undefined, { kind: 'bullet', text: 'outer' }, T);
    const child = createBlock(undefined, { kind: 'bullet', text: '', parentId: parent.id }, T + 1);

    const result = splitBlock(undefined, child.id, 0, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'outdent');
    assert.equal(getBlock(undefined, child.id)?.parentId.value, null);
  } finally { cleanup(dir); }
});

test('Enter on an empty top-level list item makes it a paragraph', () => {
  const dir = home();
  try {
    const item = createBlock(undefined, { kind: 'bullet', text: '' }, T);
    const result = splitBlock(undefined, item.id, 0, T + 1);
    assert.ok(result.ok);
    assert.equal(result.action, 'unstyle');
    assert.equal(getBlock(undefined, item.id)?.kind.value, 'paragraph');
  } finally { cleanup(dir); }
});

test('splitting a block that has children puts the tail FIRST inside it', () => {
  // As a sibling it would appear after everything nested underneath — the
  // person presses Enter mid-paragraph and the second half turns up ten lines
  // down.
  const dir = home();
  try {
    const parent = createBlock(undefined, { text: 'parent text' }, T);
    createBlock(undefined, { text: 'child', parentId: parent.id }, T + 1);

    const result = splitBlock(undefined, parent.id, 6, T + 2);
    assert.ok(result.ok);
    assert.deepEqual(order(), ['parent', ' text', 'child']);
  } finally { cleanup(dir); }
});

test('Enter inside a code block is refused with a reason, so the caller adds a line', () => {
  const dir = home();
  try {
    const code = createBlock(undefined, { kind: 'code', text: 'const a = 1;' }, T);
    const result = splitBlock(undefined, code.id, 5, T + 1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'not_splittable');
  } finally { cleanup(dir); }
});

test('a split refused by another device’s lock changes nothing at all', () => {
  // Written head-first precisely so a refusal cannot leave an orphan carrying
  // the tail while the original still holds the whole sentence.
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'one two' }, T);
    const state = readNotes(undefined);
    state.leases[block.id] = {
      blockId: block.id, deviceId: 'other-device', holder: 'a phone',
      epoch: 1, expiresAt: T + 30_000,
    };
    writeNotes(undefined, state);

    const result = splitBlock(undefined, block.id, 3, T + 1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : '', 'locked');
    assert.equal(listBlocks(undefined).length, 1, 'no orphan half was created');
    assert.equal(getBlock(undefined, block.id)?.text.value, 'one two');
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------------- merge */

test('Backspace at column zero unstyles before it merges', () => {
  const dir = home();
  try {
    createBlock(undefined, { text: 'above' }, T);
    const item = createBlock(undefined, { kind: 'bullet', text: 'below' }, T + 1);

    const first = mergeIntoPrevious(undefined, item.id, T + 2);
    assert.ok(first.ok);
    assert.equal(first.action, 'unstyle');
    assert.equal(getBlock(undefined, item.id)?.kind.value, 'paragraph');
    assert.equal(listBlocks(undefined).length, 2, 'nothing has been lost yet');
  } finally { cleanup(dir); }
});

test('Backspace merges the text into the block above and leaves the caret at the join', () => {
  const dir = home();
  try {
    const first = createBlock(undefined, { text: 'above' }, T);
    const second = createBlock(undefined, { text: 'below' }, T + 1);

    const result = mergeIntoPrevious(undefined, second.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'merge');
    assert.equal(getBlock(undefined, first.id)?.text.value, 'abovebelow');
    assert.equal(result.focusId, first.id);
    assert.equal(result.caret, 5, 'the caret sits exactly where the two met');
    assert.equal(listBlocks(undefined).length, 1);
  } finally { cleanup(dir); }
});

test('a merged block’s children are re-parented rather than orphaned', () => {
  const dir = home();
  try {
    const first = createBlock(undefined, { text: 'above' }, T);
    const second = createBlock(undefined, { text: 'below' }, T + 1);
    createBlock(undefined, { text: 'nested', parentId: second.id }, T + 2);

    const result = mergeIntoPrevious(undefined, second.id, T + 3);
    assert.ok(result.ok);
    assert.equal(getBlock(undefined, first.id)?.text.value, 'abovebelow');
    assert.deepEqual(order(), ['abovebelow', 'nested']);
  } finally { cleanup(dir); }
});

test('Backspace above a divider removes the divider rather than doing nothing', () => {
  // There is nothing to merge into. Leaving the caret stuck below a line
  // Backspace cannot pass is how an editor feels broken.
  const dir = home();
  try {
    const divider = createBlock(undefined, { kind: 'divider' }, T);
    const below = createBlock(undefined, { text: 'text' }, T + 1);

    const result = mergeIntoPrevious(undefined, below.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'remove-previous');
    assert.deepEqual(result.removedIds, [divider.id]);
    assert.equal(getBlock(undefined, below.id)?.text.value, 'text');
  } finally { cleanup(dir); }
});

test('Backspace above an image removes it rather than appending text to its URL', () => {
  // An image's text is an address, not somewhere to merge a sentence into.
  // Merging would break the image and lose the paragraph in one keystroke.
  const dir = home();
  try {
    const image = createBlock(undefined, { kind: 'image', text: 'https://example.test/a.png' }, T);
    const below = createBlock(undefined, { text: 'caption' }, T + 1);

    const result = mergeIntoPrevious(undefined, below.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'remove-previous');
    assert.deepEqual(result.removedIds, [image.id]);
    assert.equal(getBlock(undefined, below.id)?.text.value, 'caption');
  } finally { cleanup(dir); }
});

test('Backspace never destroys a page that happens to sit above', () => {
  const dir = home();
  try {
    const page = createBlock(undefined, { kind: 'page', text: 'Someone’s document' }, T);
    const below = createBlock(undefined, { text: 'text' }, T + 1);

    const result = mergeIntoPrevious(undefined, below.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'noop');
    assert.equal(listBlocks(undefined).length, 2);
  } finally { cleanup(dir); }
});

test('Enter on a divider adds a paragraph below rather than doing nothing', () => {
  // A keystroke that is inert leaves the person stuck below the thing they just
  // inserted with no way to keep typing.
  const dir = home();
  try {
    const divider = createBlock(undefined, { kind: 'divider' }, T);
    const result = splitBlock(undefined, divider.id, 0, T + 1);
    assert.ok(result.ok);
    assert.equal(getBlock(undefined, result.createdId!)?.kind.value, 'paragraph');
    assert.equal(getBlock(undefined, result.createdId!)?.parentId.value, null);
  } finally { cleanup(dir); }
});

test('Enter in a page title starts writing INSIDE the page', () => {
  const dir = home();
  try {
    const page = createBlock(undefined, { kind: 'page', text: 'Plan' }, T);
    const result = splitBlock(undefined, page.id, 4, T + 1);
    assert.ok(result.ok);
    assert.equal(getBlock(undefined, result.createdId!)?.parentId.value, page.id);
    assert.equal(getBlock(undefined, page.id)?.text.value, 'Plan', 'the title is untouched');
  } finally { cleanup(dir); }
});

test('Backspace in the first block of the document is a legal no-op', () => {
  const dir = home();
  try {
    const only = createBlock(undefined, { text: 'first' }, T);
    const result = mergeIntoPrevious(undefined, only.id, T + 1);
    assert.ok(result.ok);
    assert.equal(result.action, 'noop');
    assert.equal(listBlocks(undefined).length, 1);
  } finally { cleanup(dir); }
});

test('Backspace inside a nested paragraph outdents before it merges', () => {
  const dir = home();
  try {
    const parent = createBlock(undefined, { text: 'parent' }, T);
    const child = createBlock(undefined, { text: 'child', parentId: parent.id }, T + 1);

    const result = mergeIntoPrevious(undefined, child.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'outdent');
    assert.equal(getBlock(undefined, child.id)?.parentId.value, null);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------- table rows */

test('a table row belongs to its table: Tab and Shift-Tab do not tear it out', () => {
  // A row is a child block, so without a guard every nesting gesture applies to
  // it and Shift-Tab leaves a stray line of pipe-delimited text on the page.
  const dir = home();
  try {
    const table = createBlock(undefined, { kind: 'table' }, T);
    const row = createBlock(undefined, { kind: 'table-row', text: 'a|b', parentId: table.id }, T + 1);

    const lifted = outdentBlock(undefined, row.id, T + 2);
    assert.ok(lifted.ok);
    assert.equal(lifted.action, 'noop');
    assert.equal(getBlock(undefined, row.id)?.parentId.value, table.id);

    const nested = indentBlock(undefined, row.id, T + 3);
    assert.ok(nested.ok);
    assert.equal(nested.action, 'noop');
  } finally { cleanup(dir); }
});

test('Enter in a table row adds a row rather than cutting the cells in half', () => {
  const dir = home();
  try {
    const table = createBlock(undefined, { kind: 'table' }, T);
    const row = createBlock(undefined, { kind: 'table-row', text: 'a|b', parentId: table.id }, T + 1);

    const result = splitBlock(undefined, row.id, 1, T + 2);
    assert.ok(result.ok);
    assert.equal(getBlock(undefined, result.createdId!)?.kind.value, 'table-row');
    assert.equal(getBlock(undefined, row.id)?.text.value, 'a|b', 'the encoding is untouched');
  } finally { cleanup(dir); }
});

test('Backspace removes an empty row and refuses to join two encodings', () => {
  const dir = home();
  try {
    const table = createBlock(undefined, { kind: 'table' }, T);
    const first = createBlock(undefined, { kind: 'table-row', text: 'a|b', parentId: table.id }, T + 1);
    const second = createBlock(undefined, { kind: 'table-row', text: 'c|d', parentId: table.id }, T + 2);

    const kept = mergeIntoPrevious(undefined, second.id, T + 3);
    assert.ok(kept.ok);
    assert.equal(kept.action, 'noop', 'joining "a|b" and "c|d" would shift every column');

    const empty = createBlock(undefined, { kind: 'table-row', text: '', parentId: table.id }, T + 4);
    const dropped = mergeIntoPrevious(undefined, empty.id, T + 5);
    assert.ok(dropped.ok);
    assert.deepEqual(dropped.removedIds, [empty.id]);
    assert.equal(getBlock(undefined, first.id)?.text.value, 'a|b');
  } finally { cleanup(dir); }
});

/* --------------------------------------------------------------- structure */

test('Tab nests under the previous SIBLING, not under whatever is above', () => {
  const dir = home();
  try {
    const first = createBlock(undefined, { text: 'first' }, T);
    createBlock(undefined, { text: 'nested', parentId: first.id }, T + 1);
    const third = createBlock(undefined, { text: 'third' }, T + 2);

    const result = indentBlock(undefined, third.id, T + 3);
    assert.ok(result.ok);
    assert.equal(
      getBlock(undefined, third.id)?.parentId.value,
      first.id,
      'nesting under the previous block would have buried it two levels deep',
    );
  } finally { cleanup(dir); }
});

test('Shift-Tab lands immediately after the old parent, not at the end of the list', () => {
  const dir = home();
  try {
    const parent = createBlock(undefined, { text: 'parent' }, T);
    const child = createBlock(undefined, { text: 'child', parentId: parent.id }, T + 1);
    createBlock(undefined, { text: 'later sibling' }, T + 2);

    const result = outdentBlock(undefined, child.id, T + 3);
    assert.ok(result.ok);
    assert.deepEqual(order(), ['parent', 'child', 'later sibling']);
  } finally { cleanup(dir); }
});

test('Tab on the first child and Shift-Tab at the top level are legal no-ops', () => {
  const dir = home();
  try {
    const only = createBlock(undefined, { text: 'only' }, T);

    const nested = indentBlock(undefined, only.id, T + 1);
    assert.ok(nested.ok);
    assert.equal(nested.action, 'noop');

    const lifted = outdentBlock(undefined, only.id, T + 2);
    assert.ok(lifted.ok);
    assert.equal(lifted.action, 'noop');
  } finally { cleanup(dir); }
});

test('move up and move down swap with a sibling and stop at the ends', () => {
  const dir = home();
  try {
    createBlock(undefined, { text: 'a' }, T);
    const b = createBlock(undefined, { text: 'b' }, T + 1);
    createBlock(undefined, { text: 'c' }, T + 2);

    assert.ok(moveBlockUp(undefined, b.id, T + 3).ok);
    assert.deepEqual(order(), ['b', 'a', 'c']);

    assert.ok(moveBlockDown(undefined, b.id, T + 4).ok);
    assert.deepEqual(order(), ['a', 'b', 'c']);

    const stopped = moveBlockUp(undefined, 'nope', T + 5);
    assert.equal(stopped.ok, false);
  } finally { cleanup(dir); }
});

test('a move that has run out of siblings does not silently change nesting', () => {
  const dir = home();
  try {
    const first = createBlock(undefined, { text: 'a' }, T);
    createBlock(undefined, { text: 'b' }, T + 1);
    const result = moveBlockUp(undefined, first.id, T + 2);
    assert.ok(result.ok);
    assert.equal(result.action, 'noop');
    assert.deepEqual(order(), ['a', 'b']);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------- duplication */

test('duplicate copies the subtree, with new ids and its own outbox entries', () => {
  const dir = home();
  try {
    const page = createBlock(undefined, { kind: 'page', text: 'Plan' }, T);
    createBlock(undefined, { kind: 'bullet', text: 'step one', parentId: page.id }, T + 1);
    createBlock(undefined, { kind: 'bullet', text: 'step two', parentId: page.id }, T + 2);

    const result = duplicateBlock(undefined, page.id, T + 3);
    assert.ok(result.ok);
    assert.deepEqual(order(), ['Plan', 'step one', 'step two', 'Plan', 'step one', 'step two']);

    const ids = listBlocks(undefined).map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, 'a reused id would silently merge into the original');

    const pending = readNotes(undefined).outbox.operations.filter((op) => op.kind === 'create');
    assert.equal(pending.length, 6, 'B3: one queued operation per block');
  } finally { cleanup(dir); }
});

test('a duplicate is not added to the sidebar’s favourites', () => {
  const dir = home();
  try {
    const page = createBlock(undefined, { kind: 'page', text: 'Plan', favourite: true }, T);
    const result = duplicateBlock(undefined, page.id, T + 1);
    assert.ok(result.ok);
    assert.equal(getBlock(undefined, result.createdId!)?.favourite, undefined);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------- write path */

test('every gesture stamps the clock and queues through the one write path', () => {
  // The property that makes these operations rather than a second store.
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'one two' }, T);
    const before = readNotes(undefined);

    splitBlock(undefined, block.id, 3, T + 1);
    const after = readNotes(undefined);

    assert.ok(
      after.clock.physical > before.clock.physical || after.clock.logical > before.clock.logical,
      'a split that did not advance the clock did not go through the store',
    );
    assert.ok(after.outbox.operations.length > before.outbox.operations.length);
  } finally { cleanup(dir); }
});

test('a lease this device holds still lets its own gestures through', () => {
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'one two' }, T);
    const lease = beginEditing(undefined, block.id, T + 1);
    assert.ok(lease.ok);

    const result = splitBlock(undefined, block.id, 3, T + 2);
    assert.ok(result.ok, 'holding the lock must not refuse the holder');
    assert.equal(updateBlock(undefined, block.id, { text: 'one' }, T + 3).ok, true);
  } finally { cleanup(dir); }
});
