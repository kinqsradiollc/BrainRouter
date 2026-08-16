/**
 * ADR-029 E4 — pages, numbering, tables, favourites and the trash.
 *
 * Three of these are projections rather than stored state, and that is what is
 * being pinned: a numbered item's ordinal, a table's width and the trash are
 * all functions of the blocks. Each of them was cheaper to store, and each of
 * them would have needed its own merge rule for a value nobody typed.
 *
 * The restore tests are the load-bearing ones. Deletion is a tombstone (C5), so
 * a restore has to be an event a peer can compare against the delete it is
 * still holding — otherwise the peer's next push re-deletes the page the person
 * just brought back, a few seconds after they saw it return.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBlock, createPage, deleteBlock, getBlock, listBlocks, listFavourites,
  listTrash, noteTree, readNotes, restoreBlock, updateBlock,
} from '../notes/noteStore.js';
import { buildNoteTree } from '../notes/noteTree.js';
import { mergeNoteBlock } from '../notes/blockMerge.js';
import {
  isCollapsed, isFavourite, isLiveBlock, pageTitleOrDefault, type NoteBlock,
} from '../notes/block.js';
import { numberedOrdinals, orderedMarker } from '../notes/listNumbering.js';
import { formatTableRow, parseTableRow, setTableCell, tableCells, tableWidth } from '../notes/tableBlock.js';
import { describeTrashEntry, restoreDestination } from '../notes/trash.js';
import { searchNotes } from '../notes/noteSearch.js';
import type { Hlc } from '../sync/hybridClock.js';

const T = Date.parse('2026-08-07T09:00:00.000Z');

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-notes-meta-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------------------------- numbering */

const at = (physical: number, logical = 0, deviceId = 'da'): Hlc => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)) => ({ value, at: stamp });

function raw(id: string, kind: NoteBlock['kind']['value'], rank: string, parentId: string | null = null): NoteBlock {
  return {
    id,
    parentId: s<string | null>(parentId),
    rank: s(rank),
    kind: s(kind),
    text: s(id),
  };
}

test('a numbered list is numbered from tree position, with nothing stored', () => {
  const tree = buildNoteTree([
    raw('one', 'numbered', 'a'),
    raw('two', 'numbered', 'b'),
    raw('three', 'numbered', 'c'),
  ]);
  assert.deepEqual([...numberedOrdinals(tree.roots)], [['one', 1], ['two', 2], ['three', 3]]);
});

test('deleting a sibling renumbers with no write at all — the reason it is not stored', () => {
  const blocks = [raw('one', 'numbered', 'a'), raw('two', 'numbered', 'b'), raw('three', 'numbered', 'c')];
  const without = blocks.filter((b) => b.id !== 'two');
  const ordinals = numberedOrdinals(buildNoteTree(without).roots);
  assert.equal(ordinals.get('three'), 2, 'a stored ordinal would still say 3 and the list would read 1, 3');
});

test('a paragraph between two lists ends the run, so they are two lists', () => {
  const tree = buildNoteTree([
    raw('one', 'numbered', 'a'),
    raw('gap', 'paragraph', 'b'),
    raw('restart', 'numbered', 'c'),
  ]);
  assert.equal(numberedOrdinals(tree.roots).get('restart'), 1);
});

test('each nesting level counts on its own', () => {
  const tree = buildNoteTree([
    raw('outer-1', 'numbered', 'a'),
    raw('inner-1', 'numbered', 'a', 'outer-1'),
    raw('inner-2', 'numbered', 'b', 'outer-1'),
    raw('outer-2', 'numbered', 'b'),
  ]);
  const ordinals = numberedOrdinals(tree.roots);
  assert.equal(ordinals.get('inner-2'), 2);
  assert.equal(ordinals.get('outer-2'), 2);
});

test('the marker cycles by depth so nesting stays visible when indentation saturates', () => {
  assert.equal(orderedMarker(2, 0), '2.');
  assert.equal(orderedMarker(2, 1), 'b.');
  assert.equal(orderedMarker(4, 2), 'iv.');
  assert.equal(orderedMarker(27, 1), 'aa.');
});

/* ------------------------------------------------------------------ tables */

test('a table row round-trips its cells, delimiters and backslashes included', () => {
  const rows = [
    ['a', 'b', 'c'],
    ['has | a pipe', 'plain'],
    ['back\\slash', 'and \\| both'],
    [''],
    ['', 'trailing', ''],
  ];
  for (const cells of rows) {
    assert.deepEqual(parseTableRow(formatTableRow(cells)), cells, JSON.stringify(cells));
  }
});

test('the table’s width is derived from its rows, not stored on the table', () => {
  // A stored count and rows that merged independently would disagree, and the
  // reader would get a row missing a column or a column with no header.
  const rows = [formatTableRow(['a', 'b']), formatTableRow(['a', 'b', 'c'])];
  assert.equal(tableWidth(rows), 3);
  assert.deepEqual(tableCells(rows[0]!, 3), ['a', 'b', '']);
});

test('setting a cell past the end extends the row rather than failing', () => {
  assert.deepEqual(parseTableRow(setTableCell('a', 2, 'c')), ['a', '', 'c']);
});

/* -------------------------------------------------------------- page metadata */

test('a page’s title is the page block’s own field, and its icon and cover are stamped', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Release plan' }, T);
    assert.equal(pageTitleOrDefault(page), 'Release plan');

    updateBlock(undefined, page.id, { icon: '🚀', cover: 'https://example.test/c.png' }, T + 1);
    const stored = getBlock(undefined, page.id)!;
    assert.equal(stored.icon?.value, '🚀');
    assert.equal(stored.cover?.value, 'https://example.test/c.png');
    assert.ok(stored.icon?.at, 'every new field is stamped, or it cannot merge per field');
    assert.ok(stored.cover?.at);
  } finally { cleanup(dir); }
});

test('an untitled page is still called something clickable', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: '   ' }, T);
    assert.equal(pageTitleOrDefault(page), 'Untitled');
  } finally { cleanup(dir); }
});

test('favourites are a projection over a stamped field, in document order', () => {
  const dir = home();
  try {
    const first = createPage(undefined, { title: 'A' }, T);
    const second = createPage(undefined, { title: 'B' }, T + 1);
    createPage(undefined, { title: 'C' }, T + 2);

    updateBlock(undefined, second.id, { favourite: true }, T + 3);
    updateBlock(undefined, first.id, { favourite: true }, T + 4);

    assert.deepEqual(listFavourites(undefined).map((b) => b.text.value), ['A', 'B']);
    assert.equal(isFavourite(getBlock(undefined, first.id)!), true);
  } finally { cleanup(dir); }
});

test('a toggle’s folded state is stamped, so it merges rather than flapping', () => {
  const dir = home();
  try {
    const toggle = createBlock(undefined, { kind: 'toggle', text: 'details' }, T);
    updateBlock(undefined, toggle.id, { collapsed: true }, T + 1);
    assert.equal(isCollapsed(getBlock(undefined, toggle.id)!), true);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------------- trash */

test('deleting a page produces ONE trash entry, naming what comes back with it', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Plan' }, T);
    createBlock(undefined, { text: 'one', parentId: page.id }, T + 1);
    createBlock(undefined, { text: 'two', parentId: page.id }, T + 2);
    deleteBlock(undefined, page.id, T + 3);

    const trash = listTrash(undefined);
    assert.equal(trash.length, 1, 'forty rows for one gesture is a trash nobody can use');
    assert.equal(trash[0]!.block.id, page.id);
    assert.equal(trash[0]!.descendants, 2);
    assert.match(describeTrashEntry(trash[0]!, 'Plan'), /2 blocks inside it/);
  } finally { cleanup(dir); }
});

test('restore brings the subtree back, not an empty page', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Plan' }, T);
    createBlock(undefined, { text: 'one', parentId: page.id }, T + 1);
    deleteBlock(undefined, page.id, T + 2);
    assert.equal(listBlocks(undefined).length, 0);

    const restored = restoreBlock(undefined, page.id, T + 3);
    assert.equal(restored.length, 2);
    assert.equal(listBlocks(undefined).length, 2);
    assert.deepEqual(listTrash(undefined), []);

    const walk = noteTree(undefined);
    assert.equal(walk.roots.length, 1);
    assert.equal(walk.roots[0]!.children.length, 1, 'a page that comes back empty is the worst outcome of "restore"');
  } finally { cleanup(dir); }
});

test('a restore is an event a peer can compare against the delete it still holds', () => {
  // Clearing the tombstone instead would leave the peer no way to know the
  // deletion was already decided about — its next push simply re-deletes.
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'draft' }, T);
    deleteBlock(undefined, block.id, T + 1);
    restoreBlock(undefined, block.id, T + 2);

    const local = getBlock(undefined, block.id)!;
    assert.ok(local.deletedAt, 'the tombstone is outvoted, not erased');
    assert.ok(local.restoredAt);
    assert.equal(isLiveBlock(local), true);

    // The peer's copy still only knows about the delete.
    const peer: NoteBlock = { ...local, restoredAt: undefined as unknown as Hlc };
    delete (peer as { restoredAt?: Hlc }).restoredAt;

    const merged = mergeNoteBlock(local, peer);
    assert.equal(isLiveBlock(merged), true, 'the peer must converge on live');
    assert.equal(merged.conflicts?.deleted, undefined, 'a deliberate restore is not a question to ask again');
  } finally { cleanup(dir); }
});

test('a delete stamped after a restore wins — deleting something twice still deletes it', () => {
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'draft' }, T);
    deleteBlock(undefined, block.id, T + 1);
    restoreBlock(undefined, block.id, T + 2);
    deleteBlock(undefined, block.id, T + 3);

    assert.equal(isLiveBlock(getBlock(undefined, block.id)!), false);
    assert.equal(listTrash(undefined).length, 1);
  } finally { cleanup(dir); }
});

test('a restored block is searchable again, and a deleted one is not', () => {
  // Every read path goes through `isLiveBlock`; one that tested `deletedAt`
  // directly would make a restore appear to do nothing.
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'the parser rewrite' }, T);
    deleteBlock(undefined, block.id, T + 1);
    assert.deepEqual(searchNotes(Object.values(readNotes(undefined).blocks), 'parser'), []);

    restoreBlock(undefined, block.id, T + 2);
    const hits = searchNotes(Object.values(readNotes(undefined).blocks), 'parser');
    assert.deepEqual(hits.map((h) => h.blockId), [block.id]);
  } finally { cleanup(dir); }
});

test('a restore whose parent is still deleted is reported, not quietly relocated', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Plan' }, T);
    const child = createBlock(undefined, { text: 'one', parentId: page.id }, T + 1);
    deleteBlock(undefined, page.id, T + 2);

    const blocks = Object.values(readNotes(undefined).blocks);
    assert.deepEqual(restoreDestination(blocks, child.id), { parentId: null, reparented: true });
    assert.deepEqual(restoreDestination(blocks, page.id), { parentId: null, reparented: false });
  } finally { cleanup(dir); }
});

test('restoring a block that was never deleted does nothing and says so', () => {
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'here' }, T);
    assert.deepEqual(restoreBlock(undefined, block.id, T + 1), []);
  } finally { cleanup(dir); }
});

/* -------------------------------------------------------- new fields merge */

test('the new fields merge per field, so two devices setting two of them lose neither', () => {
  const base = raw('blk_1', 'page', 'a');
  const ours: NoteBlock = { ...base, icon: s('🚀', at(200, 0, 'da')) };
  const theirs: NoteBlock = { ...base, cover: s('cover.png', at(210, 0, 'db')) };

  const merged = mergeNoteBlock(ours, theirs);
  assert.equal(merged.icon?.value, '🚀');
  assert.equal(merged.cover?.value, 'cover.png');
  assert.equal(merged.conflicts, undefined, 'different fields are not a conflict');
});

test('folding a toggle does not resurrect a block someone deleted elsewhere', () => {
  // `collapsed` and `favourite` are view state. Counting them as edits would
  // make a sidebar pin undelete a page on another device.
  const deleted: NoteBlock = { ...raw('blk_1', 'toggle', 'a'), deletedAt: at(300, 0, 'da') };
  const folded: NoteBlock = { ...raw('blk_1', 'toggle', 'a'), collapsed: s(true, at(400, 0, 'db')) };

  const merged = mergeNoteBlock(deleted, folded);
  assert.equal(isLiveBlock(merged), false);
  assert.equal(merged.conflicts?.deleted, undefined);
});
