/**
 * ADR-029 B1 + B4 — blocks as the merge unit, pages as blocks with children.
 *
 * B1's claim is testable and this file tests it rather than restating it: two
 * people editing different paragraphs of one page must not conflict. If the
 * unit were the document that would be impossible, so a passing test here is
 * evidence the granularity is what the ADR says it is.
 *
 * The ordering tests exist because sibling order is where the block model
 * usually leaks: an integer index turns one insert into a write per sibling,
 * which under a per-block outbox (B3) means one queued operation per sibling,
 * and two devices inserting into the same gap produce the same index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRank, FIRST_RANK, isRankString, rankBetween, rankSequence } from '../notes/rank.js';
import { mergeNoteBlock, describeBlockConflict, resolveBlockConflict } from '../notes/blockMerge.js';
import { noteBlockUri, type NoteBlock } from '../notes/block.js';
import type { Hlc } from '../sync/hybridClock.js';

const A = 'da';
const B = 'db';
const at = (physical: number, logical = 0, deviceId = A): Hlc => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)) => ({ value, at: stamp });

function block(id: string, text: string, stamp = at(100), over: Partial<NoteBlock> = {}): NoteBlock {
  return {
    id,
    parentId: s<string | null>(null, stamp),
    rank: s(FIRST_RANK, stamp),
    kind: s('paragraph' as const, stamp),
    text: s(text, stamp),
    ...over,
  };
}

/* ------------------------------------------------------------------- order */

test('there is always room between two adjacent ranks, so an insert writes ONE block', () => {
  // The property an integer index cannot provide. Without it, inserting between
  // two neighbours renumbers every sibling below — one queued operation each
  // under B3's per-block outbox.
  const first = rankBetween(null, null);
  const second = rankBetween(first, null);
  const between = rankBetween(first, second);

  assert.ok(first < between && between < second, `${first} < ${between} < ${second}`);
});

test('a rank never ends in the lowest digit, or it would be one nothing can sort before', () => {
  // `0` is the smallest non-empty string over this alphabet. A rank of `A0`
  // would be an insertion point with no room above it, and the person who tried
  // would simply be unable to put a block first.
  let cursor: string | null = null;
  for (let i = 0; i < 60; i += 1) {
    cursor = rankBetween(null, cursor);
    assert.notEqual(cursor[cursor.length - 1], '0', `pass ${i} produced ${cursor}`);
  }
});

test('repeatedly inserting at the top stays ordered rather than colliding at the boundary', () => {
  const ranks: string[] = [];
  let top: string | null = null;
  for (let i = 0; i < 40; i += 1) {
    top = rankBetween(null, top);
    ranks.unshift(top);
  }
  const sorted = [...ranks].sort();
  assert.deepEqual(sorted, ranks, 'insertion order and sort order must agree');
});

test('repeatedly inserting into the SAME gap keeps producing a distinct rank', () => {
  // The stress case: dragging a block into one position over and over. Each
  // pass has to find room, or the two neighbours end up tied.
  const lo = rankBetween(null, null);
  const hi = rankBetween(lo, null);
  const seen = new Set<string>();
  let cursor = hi;
  for (let i = 0; i < 50; i += 1) {
    cursor = rankBetween(lo, cursor);
    assert.ok(cursor > lo && cursor < hi, `pass ${i}: ${lo} < ${cursor} < ${hi}`);
    assert.equal(seen.has(cursor), false, `pass ${i} repeated ${cursor}`);
    seen.add(cursor);
  }
});

test('a corrupt rank from a peer degrades the ORDER, never the ability to type', () => {
  // Ranks arrive over the wire. Throwing on a bad one would make a page
  // uneditable because something else about it was wrong.
  assert.equal(isRankString('not a rank!'), false);
  const produced = rankBetween('not a rank!', null);
  assert.equal(isRankString(produced), true);
});

test('bounds already out of order still yield a usable rank', () => {
  // A merge can leave two siblings mis-ranked. Refusing would block the edit;
  // ignoring the unusable bound merely puts the block one position off.
  const produced = rankBetween('z', 'A');
  assert.equal(isRankString(produced), true);
  assert.ok(produced > 'z');
});

test('a bulk insert fills one gap in order', () => {
  const lo = rankBetween(null, null);
  const hi = rankBetween(lo, null);
  const ranks = rankSequence(5, lo, hi);
  assert.equal(ranks.length, 5);
  assert.deepEqual([...ranks].sort(), ranks);
  assert.ok(ranks[0]! > lo && ranks[4]! < hi);
});

test('a tied rank is broken by id, so two devices render the same order', () => {
  // Without the tie-break, equal ranks order by local iteration and the two
  // devices show different pages while both report being synced.
  const left = { rank: 'U', id: 'blk_a' };
  const right = { rank: 'U', id: 'blk_b' };
  assert.ok(compareRank(left, right) < 0);
  assert.ok(compareRank(right, left) > 0);
});

/* ------------------------------------------------------------------- merge */

test('B1 — two devices editing DIFFERENT blocks of one page do not conflict', () => {
  // The entire argument for blocks as the unit. Under document-level storage
  // this pair would be a conflict, and D4's marker would fire on every
  // concurrent edit until people stopped believing it.
  const oursOne = block('blk_1', 'the first paragraph, edited here', at(300, 0, A));
  const theirsOne = block('blk_1', 'the first paragraph, edited here', at(200, 0, B));
  const oursTwo = block('blk_2', 'the second paragraph', at(200, 0, A));
  const theirsTwo = block('blk_2', 'the second paragraph, edited there', at(300, 0, B));

  const one = mergeNoteBlock(oursOne, theirsOne);
  const two = mergeNoteBlock(oursTwo, theirsTwo);

  assert.equal(one.conflicts, undefined);
  assert.equal(two.conflicts, undefined);
  assert.equal(one.text.value, 'the first paragraph, edited here');
  assert.equal(two.text.value, 'the second paragraph, edited there');
});

test('D4 stays the floor: concurrent edits to ONE block keep both versions', () => {
  // B2's lease prevents this in the common case; it cannot cover both devices
  // being offline, and this is what happens then. Losing one of the two
  // silently is the outcome D4 exists to refuse.
  const ours = block('blk_1', 'what I wrote on the laptop', at(300, 1, A));
  const theirs = block('blk_1', 'what I wrote on the phone', at(300, 1, B));

  const merged = mergeNoteBlock(ours, theirs);
  assert.ok(merged.conflicts?.text, 'a concurrent text edit must be preserved, not resolved');
  assert.equal(merged.conflicts!.text!.ours, 'what I wrote on the laptop');
  assert.equal(merged.conflicts!.text!.theirs, 'what I wrote on the phone');
  assert.match(describeBlockConflict(merged) ?? '', /Both versions are kept/);
});

test('a strictly later edit supersedes without a marker, so ordinary editing is not noisy', () => {
  const ours = block('blk_1', 'first', at(100, 0, A));
  const theirs = block('blk_1', 'second', at(500, 0, B));
  const merged = mergeNoteBlock(ours, theirs);
  assert.equal(merged.text.value, 'second');
  assert.equal(merged.conflicts, undefined);
});

test('a block deleted on one device and typed into on another comes back marked, not silently gone', () => {
  // C5's rule and D4's: neither silently undeleting nor silently discarding the
  // edit is acceptable, so the block returns undecided.
  const deleted: NoteBlock = { ...block('blk_1', 'draft', at(100)), deletedAt: at(200, 0, A) };
  const edited = block('blk_1', 'draft, expanded', at(300, 0, B));

  const merged = mergeNoteBlock(deleted, edited);
  assert.equal(merged.deletedAt, undefined, 'the edit must not vanish behind the tombstone');
  assert.equal(merged.conflicts?.deleted?.reason, 'delete_vs_edit');
  assert.match(describeBlockConflict(merged) ?? '', /deleted on one device/);
});

test('a delete with no later edit stays deleted rather than resurrecting on every sync', () => {
  const deleted: NoteBlock = { ...block('blk_1', 'draft', at(100)), deletedAt: at(300, 0, A) };
  const stale = block('blk_1', 'draft', at(100, 0, B));
  assert.ok(mergeNoteBlock(deleted, stale).deletedAt);
});

test('a block moved on two devices lands in one place without a marker', () => {
  // Position is last-writer-wins because neither placement is a sentence
  // somebody loses. Marking it would put a conflict banner on a drag.
  const ours: NoteBlock = { ...block('blk_1', 'p'), parentId: s<string | null>('page_a', at(100, 0, A)) };
  const theirs: NoteBlock = { ...block('blk_1', 'p'), parentId: s<string | null>('page_b', at(500, 0, B)) };
  const merged = mergeNoteBlock(ours, theirs);
  assert.equal(merged.parentId.value, 'page_b');
  assert.equal(merged.conflicts, undefined);
});

test('a checklist tie resolves toward done, matching the planner rather than diverging from it', () => {
  const ours: NoteBlock = { ...block('blk_1', 'ship it'), checked: s(true, at(100, 0, A)) };
  const theirs: NoteBlock = { ...block('blk_1', 'ship it'), checked: s(false, at(100, 0, B)) };
  assert.equal(mergeNoteBlock(ours, theirs).checked?.value, true);
});

test('resolving a conflict stamps a NEW edit, so the next sync cannot undo the choice', () => {
  // Writing the winner back under the losing side's original stamp would let
  // the merge re-decide it, and the person would watch their choice revert.
  const ours = block('blk_1', 'laptop version', at(300, 1, A));
  const theirs = block('blk_1', 'phone version', at(300, 1, B));
  const merged = mergeNoteBlock(ours, theirs);

  const resolved = resolveBlockConflict(merged, 'text', 'ours', at(900, 0, A));
  assert.ok(resolved);
  assert.equal(resolved!.text.value, 'laptop version');
  assert.equal(resolved!.conflicts, undefined);
  assert.equal(resolved!.text.at.physical, 900, 'the choice must be stamped as a new event');

  // The losing device now arrives with its old version; the resolution wins.
  assert.equal(mergeNoteBlock(resolved!, theirs).text.value, 'laptop version');
});

test('a block addresses itself with the same URI scheme every other mode uses', () => {
  assert.equal(noteBlockUri('blk_91c'), 'brainrouter://notes/block/blk_91c');
});
