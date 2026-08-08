/**
 * ADR-029 E4 — several blocks selected, and a drag that changes nesting.
 *
 * The failure everyone ships here is an off-by-one at the ends of a range, and
 * it is invisible until someone deletes a block they did not mean to. So the
 * range is asserted in both directions, and the drag is asserted to refuse the
 * move that would otherwise be repaired later by detaching a block from the
 * tree — which the person sees as the thing they dragged vanishing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_ACTIONS, blockDropIntent, blockLinkUri, extendSelection, isDescendantBlock,
  moveToTargets, neighbourBlockId, selectedBlockIds, turnIntoOptions,
} from './blockSelection.js';
import type { NoteBlockView } from './notesView.js';

function block(id: string, over: Partial<NoteBlockView> = {}): NoteBlockView {
  return {
    id, parentId: null, depth: 0, kind: 'paragraph', text: id, checked: false, level: null,
    hasChildren: false, collapsed: false, refs: [], conflicts: [], lockedBy: null, title: null, icon: null,
    cover: null, favourite: false, template: false, comments: [], ...over,
  };
}

const body = [block('b1'), block('b2'), block('b3'), block('b4')];

test('a selection is inclusive at both ends, whichever way it was made', () => {
  assert.deepEqual(selectedBlockIds(body, { anchorId: 'b2', focusId: 'b3' }), ['b2', 'b3']);
  assert.deepEqual(selectedBlockIds(body, { anchorId: 'b3', focusId: 'b2' }), ['b2', 'b3']);
  assert.deepEqual(selectedBlockIds(body, null), []);
});

test('shift-arrow moves the focus and leaves the anchor where it was', () => {
  const first = extendSelection(body, null, 'b2', 1)!;
  assert.deepEqual(first, { anchorId: 'b2', focusId: 'b3' });
  const back = extendSelection(body, first, 'b2', -1)!;
  assert.deepEqual(back, { anchorId: 'b2', focusId: 'b2' });
});

test('a selection stops at the ends of the page rather than wrapping', () => {
  // Wrapping would select the whole document from a keystroke that asked for
  // one more line.
  const atEnd = { anchorId: 'b4', focusId: 'b4' };
  assert.deepEqual(extendSelection(body, atEnd, 'b4', 1), atEnd);
  assert.equal(neighbourBlockId(body, 'b1', -1), null);
  assert.equal(neighbourBlockId(body, 'b1', 1), 'b2');
});

test('a drag can change nesting level, not only order', () => {
  assert.deepEqual(
    blockDropIntent(body, 'b3', 'b1', 'inside', null),
    { id: 'b3', parentId: 'b1' },
  );
  assert.deepEqual(
    blockDropIntent(body, 'b3', 'b1', 'before', null),
    { id: 'b3', parentId: null, before: 'b1' },
  );
  // The page's background lifts a nested block back out to the page itself.
  assert.deepEqual(blockDropIntent(body, 'b3', null, 'inside', 'page_1'), { id: 'b3', parentId: 'page_1' });
});

test('a block cannot be dropped inside itself, and the refusal is at the gesture', () => {
  const nested = [block('p'), block('c', { parentId: 'p' }), block('g', { parentId: 'c' })];
  assert.equal(isDescendantBlock(nested, 'p', 'g'), true);
  assert.equal(blockDropIntent(nested, 'p', 'g', 'inside', null), null);
  assert.equal(blockDropIntent(nested, 'p', 'p', 'after', null), null);
});

test('"move to" never offers a destination that would do nothing or make a cycle', () => {
  const pages = [
    block('pg1', { kind: 'page', title: 'One' }),
    block('pg2', { kind: 'page', title: 'Two', parentId: 'pg1' }),
    block('blk', { parentId: 'pg1' }),
  ];
  const targets = moveToTargets(pages, 'pg1', 'pg1', 'Top level');
  assert.deepEqual(targets.map((t) => t.id), [null]);
  const forBlock = moveToTargets(pages, 'blk', 'pg1', 'Top level');
  assert.deepEqual(forBlock.map((t) => t.title), ['Top level', 'Two']);
});

test('"turn into" only offers conversions that keep the words', () => {
  const commands = [{ kind: 'heading' }, { kind: 'todo' }, { kind: 'image' }, { kind: 'table' }];
  assert.deepEqual(turnIntoOptions(commands).map((c) => c.kind), ['heading', 'todo']);
});

test('the copied link is the address every other surface writes', () => {
  assert.equal(blockLinkUri('blk_9'), 'brainrouter://notes/block/blk_9');
  assert.equal(BLOCK_ACTIONS[BLOCK_ACTIONS.length - 1]!.id, 'delete', 'the destructive item goes last');
});
