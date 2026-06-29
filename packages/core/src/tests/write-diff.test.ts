import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReviewChunks,
  applyReview,
  acceptAll,
  rejectAll,
  reviewStats,
  type ReviewChunk,
} from '../write/writeDiff.js';

const ops = (chunks: ReviewChunk[]): string[] => chunks.map((c) => c.op);

test('identical text → a single equal chunk (or none for empty); no hunks', () => {
  assert.deepEqual(computeReviewChunks('', ''), []);
  const same = computeReviewChunks('a\nb', 'a\nb');
  assert.deepEqual(ops(same), ['equal']);
  assert.deepEqual(reviewStats(same), { added: 0, removed: 0, changed: 0, hunks: 0 });
});

test('pure insert: accept adds the line, reject keeps original', () => {
  const chunks = computeReviewChunks('a\nb', 'a\nb\nc');
  assert.deepEqual(ops(chunks), ['equal', 'insert']);
  const ins = chunks.find((c) => c.op === 'insert')!;
  assert.equal(ins.original, '');
  assert.equal(ins.revised, 'c');
  assert.equal(acceptAll(chunks), 'a\nb\nc');
  assert.equal(rejectAll(chunks), 'a\nb');
});

test('pure delete: accept removes the line (no blank left), reject keeps it', () => {
  const chunks = computeReviewChunks('a\nb\nc', 'a\nc');
  assert.deepEqual(ops(chunks), ['equal', 'delete', 'equal']);
  assert.equal(acceptAll(chunks), 'a\nc');
  assert.equal(rejectAll(chunks), 'a\nb\nc');
});

test('replace: per-chunk accept/reject picks revised vs original', () => {
  const chunks = computeReviewChunks('a\nX\nc', 'a\nY\nc');
  assert.deepEqual(ops(chunks), ['equal', 'replace', 'equal']);
  const rep = chunks.find((c) => c.op === 'replace')!;
  assert.equal(rep.original, 'X');
  assert.equal(rep.revised, 'Y');
  assert.equal(applyReview(chunks, { [rep.id]: 'accept' }), 'a\nY\nc');
  assert.equal(applyReview(chunks, { [rep.id]: 'reject' }), 'a\nX\nc');
});

test('round-trip: acceptAll === revised and rejectAll === original (many shapes)', () => {
  const pairs: Array<[string, string]> = [
    ['', 'a\nb'],
    ['a\nb', ''],
    ['a\nb\nc', 'a\nc'],
    ['a\nb', 'a\nb\nc'],
    ['hello world', 'hello brave world'],
    ['one\ntwo\nthree', 'ONE\ntwo\nTHREE\nfour'],
    ['a\nb', 'c\nd'],
    ['line\n', 'line\nmore\n'],
    ['keep\ndrop\nkeep', 'keep\nkeep'],
    ['title\n\nbody', 'title\n\nnew body\n\nmore'],
  ];
  for (const [original, revised] of pairs) {
    const chunks = computeReviewChunks(original, revised);
    assert.equal(acceptAll(chunks), revised, `acceptAll should equal revised for ${JSON.stringify([original, revised])}`);
    assert.equal(rejectAll(chunks), original, `rejectAll should equal original for ${JSON.stringify([original, revised])}`);
  }
});

test('mixed multi-hunk doc: selective decisions compose', () => {
  const original = 'intro\nold-a\nshared\nold-b\nend';
  const revised = 'intro\nnew-a\nshared\nnew-b\nend';
  const chunks = computeReviewChunks(original, revised);
  const changes = chunks.filter((c) => c.op !== 'equal');
  assert.equal(changes.length, 2);
  // accept the first replace, reject the second
  const decisions = { [changes[0].id]: 'accept' as const, [changes[1].id]: 'reject' as const };
  assert.equal(applyReview(chunks, decisions), 'intro\nnew-a\nshared\nold-b\nend');
});

test('default decision governs chunks without an explicit choice', () => {
  const chunks = computeReviewChunks('a\nX\nc', 'a\nY\nc');
  // no decisions, default reject → original
  assert.equal(applyReview(chunks, {}, 'reject'), 'a\nX\nc');
  // no decisions, default accept → revised
  assert.equal(applyReview(chunks, {}, 'accept'), 'a\nY\nc');
});

test('reviewStats counts insert/delete/replace hunks', () => {
  const chunks = computeReviewChunks('keep\ndrop\nrepl-old\ntail', 'keep\nrepl-new\ntail\nadded');
  const s = reviewStats(chunks);
  assert.equal(s.hunks, s.added + s.removed + s.changed);
  assert.ok(s.hunks >= 1);
  // every non-equal chunk is counted exactly once
  const nonEqual = chunks.filter((c) => c.op !== 'equal').length;
  assert.equal(s.hunks, nonEqual);
});

test('very large input falls back to a single whole-document replace chunk', () => {
  const big = Array.from({ length: 4100 }, (_, i) => `line ${i}`).join('\n');
  const bigger = big + '\nlast';
  const chunks = computeReviewChunks(big, bigger);
  assert.deepEqual(ops(chunks), ['replace']);
  assert.equal(acceptAll(chunks), bigger);
  assert.equal(rejectAll(chunks), big);
});
