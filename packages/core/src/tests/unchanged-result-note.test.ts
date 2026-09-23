/**
 * The loop that spanned TURNS.
 *
 * A real transcript (session 3cbe409e…, 67 MB of tool output) shows
 * `read_file {"path":"AGENT.md"}` issued **43 times across 13 turns** —
 * three or four per turn, identical results every time. The per-turn repeat
 * window resets with the turn and never sees it, and a session-wide COUNTER
 * would be the wrong instrument: between two turns the person may have edited
 * the file, and re-reading it is then exactly right.
 *
 * So compare the result, not the count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUnchangedResultStore, noteUnchangedResult, resultDigest,
} from '../agent/guards/repeatGuard.js';

const SIG = 'read_file::{"path":"AGENT.md"}';

test('the first call says nothing; an identical second call says so', () => {
  const store = createUnchangedResultStore();
  assert.equal(noteUnchangedResult(store, SIG, '# AGENT\nrules', 1_000), undefined);
  const note = noteUnchangedResult(store, SIG, '# AGENT\nrules', 61_000);
  assert.match(note ?? '', /byte-identical to what the same call returned 60s ago/);
  assert.match(note ?? '', /calling it again will return this same text/);
});

test('a file that CHANGED between turns says nothing — re-reading it is the right move', () => {
  const store = createUnchangedResultStore();
  noteUnchangedResult(store, SIG, '# AGENT\nrules', 1_000);
  assert.equal(noteUnchangedResult(store, SIG, '# AGENT\nrules\nmore', 2_000), undefined,
    'the edit is the whole reason to read again');
  // …and the NEW content becomes the baseline.
  assert.ok(noteUnchangedResult(store, SIG, '# AGENT\nrules\nmore', 3_000));
});

test('different arguments are different calls', () => {
  const store = createUnchangedResultStore();
  noteUnchangedResult(store, 'read_file::{"path":"A.md"}', 'same text', 1_000);
  assert.equal(noteUnchangedResult(store, 'read_file::{"path":"B.md"}', 'same text', 2_000), undefined);
});

test('the store is bounded, and a signature in active use is not evicted', () => {
  const store = createUnchangedResultStore(4);
  noteUnchangedResult(store, SIG, 'hot', 1_000);
  for (let i = 0; i < 20; i += 1) {
    // Re-touch the hot signature so it stays the most recently used.
    noteUnchangedResult(store, `cold-${i}`, `x${i}`, 2_000 + i);
    noteUnchangedResult(store, SIG, 'hot', 2_500 + i);
  }
  assert.ok(store.seen.size <= 4, `bounded, got ${store.seen.size}`);
  assert.ok(store.seen.has(SIG), 'the call actually being repeated survives eviction');
});

test('the digest separates length from content, cheaply', () => {
  assert.equal(resultDigest('abc'), resultDigest('abc'));
  assert.notEqual(resultDigest('abc'), resultDigest('abd'));
  assert.notEqual(resultDigest('abc'), resultDigest('abcd'));
  assert.equal(resultDigest(''), resultDigest(''));
});
