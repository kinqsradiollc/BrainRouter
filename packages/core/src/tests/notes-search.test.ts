/**
 * ADR-029 B5 — search covers content AND references.
 *
 * *"The note where I wrote about BR-114"* is the ADR's own example, and it is
 * unanswerable by prose search alone: the id lives inside a URI nobody typed as
 * words. The tests below pin both halves, and — more importantly — pin that
 * they stay SEPARATE. A search that reports a machine-generated identifier as
 * though the person had written the word is a search people stop trusting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockReferences, blocksReferencing, contentWithoutRefs,
  noteReferenceSources, searchNotes,
} from '../notes/noteSearch.js';
import type { NoteBlock } from '../notes/block.js';
import { WorkspaceBacklinkIndex } from '../workspace/references/backlinks.js';
import { noteBlockRef } from '../notes/block.js';
import type { Hlc } from '../sync/hybridClock.js';

const at: Hlc = { physical: 100, logical: 0, deviceId: 'da' };
const s = <T>(value: T) => ({ value, at });

function block(id: string, text: string, over: Partial<NoteBlock> = {}): NoteBlock {
  return {
    id,
    parentId: s<string | null>(null),
    rank: s('U'),
    kind: s('paragraph' as const),
    text: s(text),
    ...over,
  };
}

const TRACK_URI = 'brainrouter://track/work-item/BR-114';

test('B5 — a note is findable by what it LINKS TO, not only by what it says', () => {
  // The ADR's own example query. Nothing in this block's prose contains the id.
  const blocks = [
    block('blk_1', `follow up on this after the release — ${TRACK_URI}`),
    block('blk_2', 'unrelated thinking about the parser'),
  ];
  const hits = searchNotes(blocks, 'BR-114');
  assert.deepEqual(hits.map((h) => h.blockId), ['blk_1']);
  assert.deepEqual(hits[0]!.matched, ['reference']);
  assert.deepEqual(hits[0]!.matchedRefs, [TRACK_URI]);
});

test('a hit says WHICH half matched, so a link-only result is not passed off as a written mention', () => {
  const blocks = [
    block('written', 'we should really finish BR-114 this week'),
    block('linked', `see ${TRACK_URI}`),
  ];
  const hits = searchNotes(blocks, 'BR-114');
  const byId = new Map(hits.map((h) => [h.blockId, h.matched]));
  assert.deepEqual(byId.get('written'), ['text']);
  assert.deepEqual(byId.get('linked'), ['reference']);
});

test('a URI is lifted out of the prose, or every block holding a link matches the mode name', () => {
  // The naive version — match the raw text and be done — makes "planner" a hit
  // for every block containing any planner link, including ones that never
  // mention the planner at all.
  const blocks = [block('blk_1', `context: brainrouter://planner/item/itm_4f2a`)];
  const hits = searchNotes(blocks, 'planner');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.matched, ['reference'], 'a link is not prose');
  assert.equal(contentWithoutRefs(blocks[0]!.text.value), 'context:');
});

test('a block matching both halves outranks one matching only a link', () => {
  const blocks = [
    block('link-only', `see ${TRACK_URI}`),
    block('both', `BR-114 is the blocker — ${TRACK_URI}`),
  ];
  const hits = searchNotes(blocks, 'BR-114');
  assert.equal(hits[0]!.blockId, 'both');
  assert.deepEqual(hits[0]!.matched, ['text', 'reference']);
});

test('a deleted block is not a search result', () => {
  const blocks = [{ ...block('blk_1', 'the parser'), deletedAt: at }];
  assert.deepEqual(searchNotes(blocks, 'parser'), []);
});

test('an empty query returns nothing rather than everything', () => {
  // Returning every block for a blank box is how a search surface becomes a
  // very slow way to list the document.
  assert.deepEqual(searchNotes([block('blk_1', 'anything')], '   '), []);
});

test('the full URI is searchable too, for the case where somebody pastes one back in', () => {
  const blocks = [block('blk_1', `see ${TRACK_URI}`)];
  assert.equal(searchNotes(blocks, TRACK_URI).length, 1);
});

test('a block’s references are canonical and de-duplicated, so a repeat is not a second link', () => {
  const blocks = block('blk_1', `${TRACK_URI} and again ${TRACK_URI} and brainrouter://notes/block/blk_2`);
  assert.deepEqual(blockReferences(blocks), ['brainrouter://notes/block/blk_2', TRACK_URI]);
});

test('"what links here" ignores the fragment, because two citations of one file are one backlink', () => {
  const blocks = [
    block('blk_1', 'brainrouter://code/file/src/parser.ts#L59'),
    block('blk_2', 'brainrouter://code/file/src/parser.ts#L12'),
  ];
  assert.deepEqual(blocksReferencing(blocks, 'brainrouter://code/file/src/parser.ts'), ['blk_1', 'blk_2']);
});

test('A2 — the backlink index built from blocks is a projection, so rebuilding it cannot disagree', () => {
  // The index is a cache. If rebuilding from content changes the answer, the
  // index was the source of truth and A2 was not implemented.
  const before = [
    block('blk_1', `cites ${TRACK_URI}`),
    block('blk_2', `also cites ${TRACK_URI}`),
  ];
  const index = WorkspaceBacklinkIndex.rebuild(noteReferenceSources(before));

  // An edit session: one block drops the link, another gains it.
  const after = [
    block('blk_1', 'no longer cites anything'),
    block('blk_2', `also cites ${TRACK_URI}`),
    block('blk_3', `a new note about ${TRACK_URI}`),
  ];
  for (const source of noteReferenceSources(after)) index.apply(source);
  index.remove(noteBlockRef('blk_1'));

  const rebuilt = WorkspaceBacklinkIndex.rebuild(noteReferenceSources(after));
  assert.ok(rebuilt.snapshot().length > 0, 'a comparison of two empty indexes proves nothing');
  assert.deepEqual(index.snapshot(), rebuilt.snapshot());
});

test('a deleted block stops being a backlink source, so "what links here" does not cite a removed note', () => {
  const blocks = [{ ...block('blk_1', `cites ${TRACK_URI}`), deletedAt: at }];
  assert.deepEqual(noteReferenceSources(blocks), []);
});
