/**
 * ADR-029 A2 — backlinks are derived, and the index is only a cache.
 *
 * The decisive test is the last one. A2 says the index "must be rebuildable
 * from content alone — if rebuilding it changes the answer, the index was the
 * source of truth and this decision was not implemented." That sentence is only
 * enforceable if there IS an incremental path that could drift from a rebuild,
 * so the incremental path is exercised through a realistic edit session and
 * then checked against a rebuild from the final content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceRef, type WorkspaceRef } from '../workspace/references/ref.js';
import {
  WorkspaceBacklinkIndex,
  extractWorkspaceRefs,
  type WorkspaceReferenceSource,
} from '../workspace/references/backlinks.js';

const ref = (uri: string): WorkspaceRef => {
  const parsed = parseWorkspaceRef(uri);
  assert.equal(parsed.ok, true, uri);
  return (parsed as { ok: true; ref: WorkspaceRef }).ref;
};

const TASK = 'brainrouter://planner/item/itm_4f2a';
const FILE = 'brainrouter://code/file/packages/core/src/x.ts';

/* ------------------------------------------------------------- extraction */

test('a reference written in ordinary prose is found', () => {
  const refs = extractWorkspaceRefs(`Decided to defer this — see ${TASK} before Friday.`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.id, 'itm_4f2a');
});

test('a reference in a markdown link is found without its closing bracket', () => {
  // Otherwise every link written the way people actually write links resolves
  // to a target whose id ends in `)`, and nothing ever matches it.
  const refs = extractWorkspaceRefs(`[the task](${TASK})`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.id, 'itm_4f2a');
});

test('a malformed reference is dropped, not repaired into a phantom target', () => {
  // A half-parsed URI in the index becomes a backlink to something that never
  // existed, which the reader cannot trace back to the typo that caused it.
  const refs = extractWorkspaceRefs('a broken one: brainrouter://planner/item and a good one: ' + TASK);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.id, 'itm_4f2a');
});

test('a pasted wall of punctuation is scanned, not backtracked over', () => {
  // Note content is arbitrary text from arbitrary places. Trimming the trailing
  // punctuation with `/[…]+$/` — no start anchor — retries from every start
  // position, so this input would take quadratic time on a string somebody
  // pasted. It must stay linear, and it must still find the real link.
  // The punctuation run must be followed by a non-punctuation character: that
  // is the shape where `$` fails and the engine restarts from every position.
  // A run that reaches the token's end matches immediately and proves nothing.
  const hostile = `${TASK} ${'brainrouter://' + ')'.repeat(60_000) + 'a'} ${FILE}`;
  const started = Date.now();
  const refs = extractWorkspaceRefs(hostile);
  assert.ok(Date.now() - started < 1_000, 'extraction should be linear in the length of the text');
  assert.deepEqual(refs.map((r) => r.mode), ['planner', 'code']);
});

test('several references in one block are all found, in order', () => {
  const refs = extractWorkspaceRefs(`${TASK} then ${FILE}#L59 then ${TASK}`);
  assert.deepEqual(refs.map((r) => r.mode), ['planner', 'code', 'planner']);
});

/* ---------------------------------------------------------------- indexing */

test('the target of a link stores nothing; asking it what links here is a query', () => {
  const index = WorkspaceBacklinkIndex.rebuild([
    { from: ref('brainrouter://notes/block/blk_1'), text: `Blocked on ${TASK}` },
    { from: ref('brainrouter://notes/block/blk_2'), text: `Also ${TASK}` },
    { from: ref('brainrouter://notes/block/blk_3'), text: 'unrelated prose' },
  ]);
  const links = index.backlinksTo(ref(TASK));
  assert.deepEqual(links.map((l) => l.from.id), ['blk_1', 'blk_2']);
});

test('two citations of different lines are one backlink, and both lines are kept', () => {
  // Splitting a file's backlinks by line number answers a question nobody
  // asked; discarding the line loses the only thing that made the link useful.
  const index = WorkspaceBacklinkIndex.rebuild([
    { from: ref('brainrouter://notes/block/blk_1'), text: `see ${FILE}#L59 and ${FILE}#L12` },
  ]);
  const links = index.backlinksTo(ref(FILE));
  assert.equal(links.length, 1);
  assert.equal(links[0]!.count, 2);
  assert.deepEqual(links[0]!.fragments, ['L12', 'L59']);
});

test('a reference removed from a block disappears from the target immediately', () => {
  // An index that only grows starts listing notes that stopped mentioning you.
  const index = WorkspaceBacklinkIndex.rebuild([
    { from: ref('brainrouter://notes/block/blk_1'), text: `Blocked on ${TASK}` },
  ]);
  assert.equal(index.backlinksTo(ref(TASK)).length, 1);
  index.apply({ from: ref('brainrouter://notes/block/blk_1'), text: 'no longer blocked' });
  assert.deepEqual(index.backlinksTo(ref(TASK)), []);
  assert.deepEqual(index.targets(), [], 'a target nothing links to must not linger as an empty row');
});

test('deleting the referring block removes the link; deleting the TARGET is not this index\'s business', () => {
  // C5: deleting the target of a link never deletes the link — the reference
  // stays in the note and renders as a tombstone. So there is deliberately no
  // way to tell this index a target died.
  const index = WorkspaceBacklinkIndex.rebuild([
    { from: ref('brainrouter://notes/block/blk_1'), text: `Blocked on ${TASK}` },
  ]);
  index.remove(ref('brainrouter://notes/block/blk_1'));
  assert.deepEqual(index.backlinksTo(ref(TASK)), []);
  assert.equal(
    typeof (index as unknown as Record<string, unknown>)['removeTarget'],
    'undefined',
    'a verb for "the target was deleted" would be the cascade C5 forbids',
  );
});

/* ------------------------------------------------------ A2 · the cache rule */

test('rebuilding the index from content alone gives the same answer as incremental updates', () => {
  // The one that decides whether A2 was implemented. If these ever differ, the
  // incremental index is holding an edge no content produces — which makes the
  // cache the source of truth, which is the failure A2 exists to prevent.
  const blk1 = ref('brainrouter://notes/block/blk_1');
  const blk2 = ref('brainrouter://notes/block/blk_2');
  const blk3 = ref('brainrouter://notes/block/blk_3');
  const turn = ref('brainrouter://chat/turn/ses_88a/t_12');

  const live = WorkspaceBacklinkIndex.rebuild([
    { from: blk1, text: `Blocked on ${TASK}` },
    { from: blk2, text: `Both ${TASK} and ${FILE}#L59` },
    { from: blk3, text: `Only ${FILE}` },
  ]);

  // A session of ordinary edits, applied incrementally the way a running app
  // would: one block loses a reference and gains another, one is emptied, one
  // is deleted outright, and a new source appears.
  const finalContent: WorkspaceReferenceSource[] = [
    { from: blk1, text: `Moved on — now about ${FILE}#L12` },
    { from: blk2, text: 'no references left at all' },
    { from: turn, text: `Concluded: do ${TASK} first. Twice: ${TASK}` },
  ];
  for (const source of finalContent) live.apply(source);
  live.remove(blk3);

  const rebuilt = WorkspaceBacklinkIndex.rebuild(finalContent);

  assert.deepEqual(live.snapshot(), rebuilt.snapshot());
  // And the answer is not trivially empty on both sides, which would pass
  // while proving nothing.
  assert.ok(rebuilt.snapshot().length > 0);
  assert.deepEqual(
    rebuilt.backlinksTo(ref(TASK)).map((l) => [l.from.id, l.count]),
    [['ses_88a/t_12', 2]],
  );
});

test('rebuilding twice from the same content is stable, so the comparison above means something', () => {
  const sources: WorkspaceReferenceSource[] = [
    { from: ref('brainrouter://notes/block/blk_2'), text: `${FILE}#L59` },
    { from: ref('brainrouter://notes/block/blk_1'), text: `${TASK} ${FILE}` },
  ];
  const a = WorkspaceBacklinkIndex.rebuild(sources).snapshot();
  const b = WorkspaceBacklinkIndex.rebuild([...sources].reverse()).snapshot();
  assert.deepEqual(a, b, 'the snapshot must not depend on the order sources arrived in');
});
