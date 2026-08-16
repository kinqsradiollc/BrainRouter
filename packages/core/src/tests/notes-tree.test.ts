/**
 * ADR-029 B4 + Q3 — one recursion for pages, and the bounded slice an agent
 * gets.
 *
 * B4's claim is that a page needs no separate type, and the way to test that is
 * to build a page out of ordinary blocks and check it nests. The rest of this
 * file is about the two ways a flat parent pointer loses content: a cycle two
 * devices produced concurrently, and a child whose parent is gone. Both make
 * blocks that exist and cannot be reached — A3's quietly-wrong shape, applied
 * to a document's own structure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockContext, buildNoteTree, headingAncestry, MAX_CONTEXT_TEXT,
  pageOf, subtreeBlockIds,
} from '../notes/noteTree.js';
import type { NoteBlock, NoteBlockKind } from '../notes/block.js';
import type { Hlc } from '../sync/hybridClock.js';

const at = (physical: number, deviceId = 'da'): Hlc => ({ physical, logical: 0, deviceId });
const s = <T>(value: T, stamp = at(100)) => ({ value, at: stamp });

function block(
  id: string,
  over: { parent?: string | null; rank?: string; kind?: NoteBlockKind; text?: string; at?: Hlc } = {},
): NoteBlock {
  const stamp = over.at ?? at(100);
  return {
    id,
    parentId: s<string | null>(over.parent ?? null, stamp),
    rank: s(over.rank ?? 'U', stamp),
    kind: s((over.kind ?? 'paragraph') as NoteBlockKind, stamp),
    text: s(over.text ?? id, stamp),
  };
}

test('B4 — a page is a block with children, and nesting is the same recursion at every depth', () => {
  const blocks = [
    block('page', { kind: 'page', text: 'Release notes', rank: 'A' }),
    block('sub', { parent: 'page', kind: 'page', text: 'Known issues', rank: 'A' }),
    block('para', { parent: 'sub', text: 'the parser is slow', rank: 'A' }),
  ];
  const tree = buildNoteTree(blocks);

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]!.block.id, 'page');
  assert.equal(tree.roots[0]!.children[0]!.block.id, 'sub');
  assert.equal(tree.roots[0]!.children[0]!.children[0]!.block.id, 'para');
  assert.equal(tree.roots[0]!.children[0]!.children[0]!.depth, 2);
  assert.deepEqual(tree.repairs, []);
});

test('siblings render in rank order regardless of the order the blocks arrived in', () => {
  const tree = buildNoteTree([
    block('third', { rank: 'k' }),
    block('first', { rank: 'A' }),
    block('second', { rank: 'U' }),
  ]);
  assert.deepEqual(tree.roots.map((n) => n.block.id), ['first', 'second', 'third']);
});

test('a cycle two devices produced concurrently is broken instead of followed forever', () => {
  // `parentId` merges per block by last-writer-wins, so A-under-B and
  // B-under-A can both win their own field. No sync bug is required; a naive
  // recursive build simply never terminates.
  const tree = buildNoteTree([
    block('a', { parent: 'b' }),
    block('b', { parent: 'a' }),
  ]);
  assert.equal(tree.roots.length >= 1, true);
  assert.equal(tree.repairs.some((r) => r.reason === 'cycle'), true);
  assert.deepEqual(
    [...collectIds(tree)].sort(),
    ['a', 'b'],
    'breaking the cycle must not lose either block',
  );
});

test('a cycle is broken the SAME way on both devices, or they render different documents', () => {
  // Detaching "whichever we visited first" would depend on iteration order, and
  // two devices holding identical blocks would disagree while both report being
  // fully synced.
  const forward = buildNoteTree([block('a', { parent: 'b' }), block('b', { parent: 'a' })]);
  const reversed = buildNoteTree([block('b', { parent: 'a' }), block('a', { parent: 'b' })]);
  assert.deepEqual(
    forward.roots.map((n) => n.block.id),
    reversed.roots.map((n) => n.block.id),
  );
});

test('a child of a deleted parent surfaces at the top rather than disappearing from every page', () => {
  // Present in the data, absent from the document, is the failure A3 argues is
  // worse than an obvious hole: nobody notices content that stopped rendering.
  const parent: NoteBlock = { ...block('page', { kind: 'page' }), deletedAt: at(200) };
  const tree = buildNoteTree([parent, block('orphan', { parent: 'page' })]);

  assert.deepEqual(tree.roots.map((n) => n.block.id), ['orphan']);
  assert.deepEqual(tree.repairs, [
    { blockId: 'orphan', reason: 'deleted_parent', claimedParentId: 'page' },
  ]);
});

test('a child whose parent never arrived is reported as a repair, not silently reparented', () => {
  // The block still renders — but the reason it moved is available, so a
  // surface can say so rather than leaving the person to infer a bug.
  const tree = buildNoteTree([block('child', { parent: 'page_that_has_not_synced_yet' })]);
  assert.equal(tree.repairs[0]!.reason, 'missing_parent');
  assert.equal(tree.repairs[0]!.claimedParentId, 'page_that_has_not_synced_yet');
});

test('a subtree walk returns the block first and then its descendants in reading order', () => {
  const blocks = [
    block('page', { kind: 'page' }),
    block('one', { parent: 'page', rank: 'A' }),
    block('two', { parent: 'page', rank: 'U' }),
    block('one-a', { parent: 'one', rank: 'A' }),
  ];
  assert.deepEqual(subtreeBlockIds(blocks, 'page'), ['page', 'one', 'one-a', 'two']);
});

/* --------------------------------------------------------------- Q3 context */

test('Q3 — resolving a block yields the block and its headings, never the page', () => {
  // A page is unbounded: someone's meeting notes run to thousands of words, so
  // "include the page" has no upper limit and would consume the context
  // belonging to the actual task.
  const blocks = [
    block('page', { kind: 'page', text: 'Parser rewrite', rank: 'A' }),
    block('h', { parent: 'page', kind: 'heading', text: 'Open questions', rank: 'A' }),
    block('target', { parent: 'page', text: 'do we keep the old lexer?', rank: 'U' }),
    block('other', { parent: 'page', text: 'unrelated paragraph', rank: 'k' }),
  ];

  const context = blockContext(blocks, 'target');
  assert.ok(context);
  assert.equal(context!.block.id, 'target');
  assert.deepEqual(context!.headings, ['Parser rewrite', 'Open questions']);
  assert.equal(context!.omitted, 3);
  assert.equal(context!.omittedLabel, '+3 more blocks on this page');
});

test('heading ancestry names what the block is ABOUT, not what happens to sit beside it', () => {
  // Q3 chose headings over neighbours for exactly this reason, and the
  // difference shows when the nearest neighbour is an unrelated paragraph.
  const blocks = [
    block('h', { kind: 'heading', text: 'Deployment', rank: 'A' }),
    block('noise', { text: 'a stray line', rank: 'U' }),
    block('target', { text: 'the migration runs on boot', rank: 'k' }),
  ];
  assert.deepEqual(headingAncestry(blocks, 'target').map((b) => b.text.value), ['Deployment']);
});

test('a single enormous block is capped too, because a block is only NEARLY bounded', () => {
  // A pasted code block or an imported transcript paragraph has no limit
  // either, so the cap is applied where the text is read.
  const huge = block('target', { text: 'x'.repeat(MAX_CONTEXT_TEXT * 3) });
  const context = blockContext([huge], 'target');
  assert.ok(context);
  assert.equal(context!.truncated, true);
  assert.ok(context!.text.length <= MAX_CONTEXT_TEXT + 1);
});

test('a deleted block resolves to nothing, so a tombstone is not rendered as content', () => {
  const gone: NoteBlock = { ...block('target', { text: 'removed' }), deletedAt: at(300) };
  assert.equal(blockContext([gone], 'target'), null);
});

test('the enclosing page is found through nesting, so a sub-page reports itself and not the root', () => {
  const blocks = [
    block('root', { kind: 'page', text: 'Everything' }),
    block('sub', { parent: 'root', kind: 'page', text: 'This week' }),
    block('target', { parent: 'sub', text: 'a line' }),
  ];
  assert.equal(pageOf(blocks, 'target')?.id, 'sub');
});

function collectIds(tree: { roots: Array<{ block: NoteBlock; children: unknown[] }> }): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: Array<{ block: NoteBlock; children: unknown[] }>): void => {
    for (const node of nodes) {
      ids.add(node.block.id);
      walk(node.children as Array<{ block: NoteBlock; children: unknown[] }>);
    }
  };
  walk(tree.roots);
  return ids;
}
