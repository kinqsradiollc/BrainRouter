import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTranscript, formatMatches } from '../state/transcriptSearch.js';
import type { TranscriptEntry } from '../state/sessionStore.js';

const T = (role: string, content: unknown, ts = '2026-06-10T03:00:00.000Z'): TranscriptEntry =>
  ({ role, content, timestamp: ts });

const ENTRIES: TranscriptEntry[] = [
  T('user', 'find the recall bug in the router'),
  T('assistant', 'Looking at the Router now.'),
  T('tool', 'router.ts:42 — reranker replaced the retriever order'),
  T('assistant', 'The bug: the reranker REPLACED the retriever order. Fixed by blending scores.'),
  T('user', 'thanks'),
];

test('searchTranscript: case-insensitive matches in transcript order', () => {
  const m = searchTranscript(ENTRIES, 'router');
  assert.deepEqual(m.map((x) => x.index), [0, 1, 2]);
  assert.equal(m[0].role, 'user');
  assert.match(m[2].snippet, /router\.ts:42/);
});

test('searchTranscript: per-entry occurrence count', () => {
  const m = searchTranscript(ENTRIES, 'reranker');
  assert.deepEqual(m.map((x) => [x.index, x.count]), [[2, 1], [3, 1]]);
  const multi = searchTranscript([T('assistant', 'a b a b a')], 'a');
  assert.equal(multi[0].count, 3);
});

test('searchTranscript: case-sensitive mode', () => {
  assert.equal(searchTranscript(ENTRIES, 'REPLACED', { caseSensitive: true }).length, 1);
  assert.equal(searchTranscript(ENTRIES, 'replaced', { caseSensitive: true }).length, 1); // tool entry is lowercase
  assert.equal(searchTranscript(ENTRIES, 'REPLACED').length, 2); // insensitive hits both
});

test('searchTranscript: snippet windows long content with ellipses', () => {
  const long = 'x'.repeat(500) + ' NEEDLE ' + 'y'.repeat(500);
  const m = searchTranscript([T('assistant', long)], 'needle', { snippetRadius: 20 });
  assert.equal(m.length, 1);
  assert.ok(m[0].snippet.startsWith('…'));
  assert.ok(m[0].snippet.endsWith('…'));
  assert.ok(m[0].snippet.length < 120);
});

test('searchTranscript: empty query / no hits / limit', () => {
  assert.deepEqual(searchTranscript(ENTRIES, '  '), []);
  assert.deepEqual(searchTranscript(ENTRIES, 'zzz-not-here'), []);
  const many = Array.from({ length: 80 }, (_, i) => T('user', `hit ${i}`));
  assert.equal(searchTranscript(many, 'hit').length, 50, 'default limit caps at 50');
});

test('searchTranscript: non-string content is searched via JSON', () => {
  const m = searchTranscript([T('tool', { file: 'recall.ts', ok: true })], 'recall.ts');
  assert.equal(m.length, 1);
});

test('formatMatches: jump-list lines + empty message', () => {
  const lines = formatMatches(searchTranscript(ENTRIES, 'router'), 'router');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ {2}#0 user 03:00:00: /);
  assert.deepEqual(formatMatches([], 'nope'), ['No matches for "nope".']);
});
