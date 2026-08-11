/**
 * ADR-029 Part F — the judgement behind the blocks that used to render as text.
 *
 * F1's bar is that nothing promises what it does not do, so what is asserted
 * here is mostly the honest-failure half: a fold that does not hide text from a
 * search, a picture that says why it is not on screen, a bookmark that is still
 * a link when the fetch got nothing, and an embed whose "gone" reads as a
 * sentence. Those are the branches that turn an offer the product cannot honour
 * back into an offer it can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bodyRows, collapsedCount, collapsedHiddenIds, tableOwnedIds, toggleActionLabel,
} from './blockVisibility.js';
import {
  addColumnWrites, canAddColumn, canRemoveColumn, columnLabel, headerActionLabel,
  newRowText, removeColumnWrites, rowIsEditable, setCellWrite, tableGrid,
} from './tableView.js';
import { bookmarkFailureNote, bookmarkMonogram, bookmarkState, bookmarkUrl } from './bookmarkView.js';
import { imageState, IMAGE_REMOTE_NOTE, firstImageItem, notAPictureNote } from './imageView.js';
import { embedMode, embedState, isWorkspaceReference } from './embedView.js';
import { calloutIcon, DEFAULT_CALLOUT_ICON, placeholderFor, rendersOwnSurface } from './notesView.js';
import { parseTableRow } from '@kinqs/brainrouter-core/notes/editing';
import type { NoteBlockView } from './notesView.js';

function block(id: string, over: Partial<NoteBlockView> = {}): NoteBlockView {
  return {
    id, parentId: null, depth: 0, kind: 'paragraph', text: id, checked: false, level: null,
    hasChildren: false, collapsed: false, refs: [], conflicts: [], lockedBy: null,
    title: null, icon: null, cover: null, favourite: false, template: false, comments: [], ...over,
  };
}

/* ------------------------------------------------------------------ toggle */

const FOLDED = [
  block('t1', { kind: 'toggle', text: 'Design notes', collapsed: true, hasChildren: true }),
  block('c1', { parentId: 't1', text: 'the parser is unbounded' }),
  block('c2', { parentId: 't1', text: 'and so is the exporter' }),
  block('c2a', { parentId: 'c2', text: 'nested one deeper' }),
  block('after', { text: 'a line after the toggle' }),
];

test('a collapsed toggle folds its whole subtree, not just its children', () => {
  const hidden = collapsedHiddenIds(FOLDED);
  assert.deepEqual([...hidden].sort(), ['c1', 'c2', 'c2a']);
  assert.equal(hidden.has('t1'), false, 'the toggle itself is still on screen');
  assert.equal(hidden.has('after'), false);
});

test('an open toggle hides nothing', () => {
  const open = FOLDED.map((b) => (b.id === 't1' ? { ...b, collapsed: false } : b));
  assert.equal(collapsedHiddenIds(open).size, 0);
});

test('THE bug this must never have: a fold does not hide text from a search', () => {
  const matches = new Set(['c2a']);
  const hidden = collapsedHiddenIds(FOLDED, matches);
  assert.equal(hidden.has('c2a'), false, 'a hit inside a fold is shown, or the page reports itself empty');
  assert.equal(hidden.has('c1'), true, 'everything that did not match stays folded');

  // And the FOLD is a projection, never a filter over the data: the blocks are
  // all still in the list the caller was given, so nothing downstream — search,
  // reference resolution, export — can lose them because a parent was folded.
  assert.equal(FOLDED.length, 5);
  assert.ok(FOLDED.some((b) => b.id === 'c2a'));
});

test('the twisty says how much it is hiding, and does not claim to hide nothing', () => {
  assert.equal(collapsedCount(FOLDED, 't1'), 3);
  assert.equal(toggleActionLabel(true, 3), 'Show 3 lines inside');
  assert.equal(toggleActionLabel(true, 1), 'Show 1 line inside');
  assert.equal(toggleActionLabel(false, 3), 'Hide what is inside');
  assert.match(toggleActionLabel(false, 0), /Nothing inside yet/);
});

/* ------------------------------------------------------------------- table */

const TABLE = [
  block('tbl', { kind: 'table', checked: true }),
  block('r0', { parentId: 'tbl', kind: 'table-row', text: 'Name|Owner|Due' }),
  block('r1', { parentId: 'tbl', kind: 'table-row', text: 'Parser|Ana|Friday' }),
  block('r2', { parentId: 'tbl', kind: 'table-row', text: 'Sync|Bo' }),
  block('loose', { text: 'a paragraph beside the table' }),
];

test('a table draws its own rows, so they are not also loose lines on the page', () => {
  assert.deepEqual([...tableOwnedIds(TABLE)].sort(), ['r0', 'r1', 'r2']);
  assert.deepEqual(bodyRows(TABLE).map((b) => b.id), ['tbl', 'loose']);
});

test('a search that matched a cell surfaces the TABLE, not the encoded row', () => {
  // `r1`'s text is `Parser|Ana|Friday`. Rendering it raw would put a pipe-
  // delimited line in the document; dropping it would report a page as having
  // nothing that matches a word plainly on it.
  const rows = bodyRows(TABLE, new Set(['r1']));
  assert.deepEqual(rows.map((b) => b.id), ['tbl']);
});

test('the grid is as wide as its widest row, and a short row shows empty cells', () => {
  const grid = tableGrid(TABLE[0]!, TABLE);
  assert.equal(grid.width, 3);
  assert.equal(grid.hasHeader, true);
  assert.deepEqual(grid.header?.cells, ['Name', 'Owner', 'Due']);
  assert.deepEqual(grid.body.map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(grid.body[1]?.cells, ['Sync', 'Bo', '']);
});

test('the header toggle is the table block\'s own stamped field, so it merges', () => {
  const noHeader = tableGrid({ ...TABLE[0]!, checked: false }, TABLE);
  assert.equal(noHeader.hasHeader, false);
  assert.equal(noHeader.header, null);
  assert.deepEqual(noHeader.body.map((r) => r.id), ['r0', 'r1', 'r2'], 'the first row becomes data');
  assert.equal(headerActionLabel(true), 'Use the first row as data');
  assert.equal(headerActionLabel(false), 'Use the first row as headings');
});

test('a column edit is one write per row, because a row is the merge unit', () => {
  const grid = tableGrid(TABLE[0]!, TABLE);

  const widened = addColumnWrites(grid, 1);
  assert.deepEqual(widened.map((w) => w.id), ['r0', 'r1', 'r2']);
  assert.deepEqual(parseTableRow(widened[0]!.text), ['Name', '', 'Owner', 'Due']);
  // The short row is padded by the same edit that widens it, so the table does
  // not end up one cell out of alignment on the row nobody finished.
  assert.deepEqual(parseTableRow(widened[2]!.text), ['Sync', '', 'Bo', '']);

  const narrowed = removeColumnWrites(grid, 2);
  assert.deepEqual(parseTableRow(narrowed[1]!.text), ['Parser', 'Ana']);

  assert.deepEqual(removeColumnWrites(tableGrid(block('t', { kind: 'table' }), [
    block('t', { kind: 'table' }), block('x', { parentId: 't', kind: 'table-row', text: 'only' }),
  ]), 0), [], 'the last column is never removed — the row would have nowhere to hold its text');
});

test('one cell edited is one write, and the escape survives it', () => {
  const grid = tableGrid(TABLE[0]!, TABLE);
  const write = setCellWrite(grid.body[0]!, 1, 'Ana|Bo');
  assert.equal(write.id, 'r1');
  assert.deepEqual(parseTableRow(write.text), ['Parser', 'Ana|Bo', 'Friday']);
});

test('a table reports what it can and cannot do rather than offering both always', () => {
  const grid = tableGrid(TABLE[0]!, TABLE);
  assert.equal(canAddColumn(grid), true);
  assert.equal(canRemoveColumn(grid), true);
  assert.equal(columnLabel(grid, 1), 'Owner');
  assert.equal(columnLabel({ ...grid, header: null, hasHeader: false }, 1), 'Column 2');
  assert.equal(newRowText(grid), '||');
  assert.equal(rowIsEditable(grid.body[0]!), true);
  assert.equal(rowIsEditable({ ...grid.body[0]!, lockedBy: 'Being edited on another device' }), false);
});

test('an empty table is a grid with no rows rather than a crash', () => {
  const only = [block('t', { kind: 'table' })];
  const grid = tableGrid(only[0]!, only);
  assert.equal(grid.rows.length, 0);
  assert.equal(grid.hasHeader, false);
  assert.equal(grid.width, 1);
});

/* ------------------------------------------------------------------- image */

test('an image block never renders a broken glyph — it names the reason', () => {
  assert.deepEqual(imageState('', null), { state: 'empty' });
  assert.deepEqual(imageState('attachment:att_1', null), { state: 'loading', id: 'att_1' });

  const ready = imageState('attachment:att_1', { id: 'att_1', name: 'shot.png', dataUri: 'data:image/png;base64,AA', width: 12, height: 8 });
  assert.deepEqual(ready, { state: 'ready', id: 'att_1', src: 'data:image/png;base64,AA', alt: 'shot.png', width: 12, height: 8 });

  const missing = imageState('attachment:att_1', { id: 'att_1', name: 'shot.png', error: 'its file is not on this machine.' });
  assert.equal(missing.state, 'missing');
  if (missing.state === 'missing') {
    assert.match(missing.note, /shot\.png/);
    assert.match(missing.note, /not on this machine/);
  }
});

test('a pasted web address is reported as one, with the offer to store it (D3)', () => {
  const remote = imageState('https://a.test/cat.png', null);
  assert.deepEqual(remote, { state: 'remote', url: 'https://a.test/cat.png', note: IMAGE_REMOTE_NOTE });
  assert.match(IMAGE_REMOTE_NOTE, /kept once/);
});

test('text that is not a picture keeps its text and says so', () => {
  const junk = imageState('a picture of a cat', null);
  assert.equal(junk.state, 'unusable');
  if (junk.state === 'unusable') {
    assert.equal(junk.text, 'a picture of a cat');
    assert.match(junk.note, /turn the block back into text/);
  }
});

test('a paste with one picture in three formats stores one picture', () => {
  assert.equal(firstImageItem([
    { kind: 'string', type: 'text/html' },
    { kind: 'file', type: 'image/png' },
    { kind: 'file', type: 'image/tiff' },
  ]), 1);
  assert.equal(firstImageItem([{ kind: 'string', type: 'text/plain' }]), -1);
  assert.equal(notAPictureNote('notes.pdf', 'application/pdf'), 'notes.pdf is a application/pdf, not a picture.');
});

/* ---------------------------------------------------------------- bookmark */

test('a bookmark that cannot be previewed is still a working link', () => {
  const failed = bookmarkState('https://a.test/page', {
    ok: false,
    failure: { url: 'https://a.test/page', host: 'a.test', reason: 'timeout', detail: 'timed out' },
  });
  assert.equal(failed.state, 'link-only');
  if (failed.state === 'link-only') {
    assert.equal(failed.url, 'https://a.test/page', 'the address survives every failure');
    assert.match(failed.note, /The link still works/);
  }
});

test('each bookmark failure gets its own sentence, because the next move differs', () => {
  assert.match(bookmarkFailureNote('blocked'), /inside this machine or its network/);
  assert.match(bookmarkFailureNote('not_a_page'), /file rather than a page/);
  assert.match(bookmarkFailureNote('http_error', '404 Not Found'), /404 Not Found/);
  assert.match(bookmarkFailureNote('something-new'), /No preview could be read/);
});

test('a bookmark with an empty title falls back to its host rather than a blank line', () => {
  const ready = bookmarkState('https://a.test/page', {
    ok: true,
    preview: { url: 'https://a.test/page', host: 'a.test', title: '   ', description: '' },
  });
  assert.equal(ready.state, 'ready');
  if (ready.state === 'ready') assert.equal(ready.preview.title, 'a.test');
});

test('a bookmark only accepts a web address, and says so when it has something else', () => {
  assert.equal(bookmarkUrl('https://a.test/x'), 'https://a.test/x');
  assert.equal(bookmarkUrl('javascript:alert(1)'), null);
  assert.equal(bookmarkUrl('file:///etc/passwd'), null);
  assert.equal(bookmarkUrl('  '), null);

  const junk = bookmarkState('see the docs', null);
  assert.equal(junk.state, 'not-a-link');

  assert.deepEqual(bookmarkState('', null), { state: 'empty' });
  assert.equal(bookmarkState('https://a.test/x', null).state, 'loading');
  assert.equal(bookmarkMonogram('www.a.test'), 'A');
  assert.equal(bookmarkMonogram(''), '·');
});

/* ------------------------------------------------------------------- embed */

test('an embed resolves live, and its non-found states read as sentences', () => {
  assert.deepEqual(embedState('', null), { state: 'empty' });
  assert.equal(embedState('brainrouter://planner/item/itm_1', null).state, 'loading');

  const found = embedState('brainrouter://planner/item/itm_1', {
    resolution: { status: 'found' }, line: 'Ship the parser fix — done',
  });
  assert.deepEqual(found, {
    state: 'found', uri: 'brainrouter://planner/item/itm_1',
    label: 'Ship the parser fix — done', mode: 'planner',
  });

  for (const [status, line] of [
    ['gone', 'planner item (deleted 4 Aug)'],
    ['denied', 'an item you do not have access to'],
    ['unavailable', 'code file (not available in this app)'],
  ] as const) {
    const state = embedState('brainrouter://planner/item/itm_1', { resolution: { status }, line });
    assert.equal(state.state, 'unresolved');
    // The sentence is core's, so six modes cannot write six different ones —
    // and an empty box is never one of the outcomes.
    if (state.state === 'unresolved') {
      assert.equal(state.note, line);
      assert.ok(state.note.length > 0);
    }
  }
});

test('a status this build has never heard of still renders the sentence it was sent', () => {
  const state = embedState('brainrouter://planner/item/itm_1', {
    resolution: { status: 'quarantined' }, line: 'held for review',
  });
  assert.equal(state.state, 'unresolved');
  if (state.state === 'unresolved') assert.equal(state.note, 'held for review');
});

test('an embed knows a reference from a sentence', () => {
  assert.equal(isWorkspaceReference('brainrouter://notes/block/blk_1'), true);
  assert.equal(isWorkspaceReference('brainrouter://code/file/packages/core/src/a.ts#L4'), true);
  assert.equal(isWorkspaceReference('https://a.test'), false);
  assert.equal(isWorkspaceReference('brainrouter://planner'), false);
  assert.equal(isWorkspaceReference(`brainrouter://planner/item/${'x'.repeat(900)}`), false);
  assert.equal(embedMode('brainrouter://meetings/action/mtg_5/a_2'), 'meetings');

  const junk = embedState('see the task', null);
  assert.equal(junk.state, 'not-a-reference');
  if (junk.state === 'not-a-reference') assert.match(junk.note, /turn this back into text/);
});

/* ------------------------------------------------- adversarial user text */

test('every Part F parser stays linear on 100k of adversarial block text', () => {
  // A block's text is whatever somebody typed, pasted, or synced in from a
  // shared source, and each of these runs on every render of the block holding
  // it. This repository closed a polynomial-ReDoS alert; these are the three
  // expressions Part F added that see that text.
  const cases: Array<{ name: string; input: string; parse: (input: string) => unknown }> = [
    {
      name: 'an embed reference',
      input: `brainrouter://${'a'.repeat(50_000)}/${'b'.repeat(50_000)}`,
      parse: (input) => embedState(input, null),
    },
    {
      name: 'a bookmark address',
      input: `https://${'a'.repeat(50_000)}.${'b'.repeat(50_000)}`,
      parse: (input) => bookmarkState(input, null),
    },
    {
      name: 'an image reference',
      input: `attachment:${'.'.repeat(100_000)}`,
      parse: (input) => imageState(input, null),
    },
    {
      name: 'a table row',
      input: 'a|'.repeat(50_000),
      parse: (input) => tableGrid(
        block('t', { kind: 'table' }),
        [block('t', { kind: 'table' }), block('r', { parentId: 't', kind: 'table-row', text: input })],
      ),
    },
  ];

  for (const { name, input, parse } of cases) {
    assert.ok(input.length >= 100_000, `${name}: expected >=100k, got ${input.length}`);
    const started = Date.now();
    const out = parse(input);
    const elapsed = Date.now() - started;
    assert.ok(out, `${name} produced nothing`);
    assert.ok(elapsed < 1_000, `${name} took ${elapsed}ms — a bounded scan should be milliseconds`);
  }
});

test('an over-long reference is refused rather than parsed at length', () => {
  // The guard is a length check BEFORE the expression, so the bounded pattern
  // never even sees an input that could make its bound matter.
  assert.equal(isWorkspaceReference(`brainrouter://planner/item/${'x'.repeat(100_000)}`), false);
  assert.equal(bookmarkState(`https://a.test/${'x'.repeat(100_000)}`, null).state, 'loading');
});

/* ---------------------------------------------------------------- the rest */

test('every kind that draws its own surface is named once, and callouts have a glyph', () => {
  for (const kind of ['image', 'bookmark', 'embed', 'table']) {
    assert.equal(rendersOwnSurface(kind), true, `${kind} draws itself`);
  }
  for (const kind of ['paragraph', 'toggle', 'callout', 'heading', 'table-row']) {
    assert.equal(rendersOwnSurface(kind), false, `${kind} is prose with a shape around it`);
  }
  assert.equal(calloutIcon(null), DEFAULT_CALLOUT_ICON);
  assert.equal(calloutIcon('  '), DEFAULT_CALLOUT_ICON);
  assert.equal(calloutIcon('🐛'), '🐛');
  assert.match(placeholderFor('callout'), /skimmed past/);
  assert.match(placeholderFor('bookmark'), /web address/);
  assert.match(placeholderFor('toggle'), /indent the detail/);
});
