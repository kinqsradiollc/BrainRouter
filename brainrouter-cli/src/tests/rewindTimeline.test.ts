import test from 'node:test';
import assert from 'node:assert/strict';
import { previewText, buildRewindTimeline, truncateAtTurn } from '../runtime/rewindTimeline.js';
import type { TranscriptEntry } from '../state/sessionStore.js';

const u = (text: string, ts: string): TranscriptEntry => ({ role: 'user', content: text, timestamp: ts });
const a = (text: string, ts = 't'): TranscriptEntry => ({ role: 'assistant', content: text, timestamp: ts });

test('0.4.x-3 previewText: string, content-parts, empty, clip', () => {
  assert.equal(previewText('hello world'), 'hello world');
  assert.equal(previewText('  multi\n  line\ttext '), 'multi line text');
  assert.equal(previewText([{ type: 'text', text: 'from parts' }]), 'from parts');
  assert.equal(previewText(''), '(empty)');
  assert.equal(previewText(undefined), '(empty)');
  assert.equal(previewText('x'.repeat(100), 10), 'xxxxxxxxx…');
});

test('0.4.x-3 buildRewindTimeline: one turn per user entry, endIndex spans the exchange', () => {
  const entries: TranscriptEntry[] = [
    u('first', '2026-01-01T00:00:00Z'),  // 0
    a('ans 1'),                          // 1
    u('second', '2026-01-01T00:01:00Z'), // 2
    a('ans 2a'),                         // 3
    a('ans 2b'),                         // 4
    u('third', '2026-01-01T00:02:00Z'),  // 5
    a('ans 3'),                          // 6
  ];
  const tl = buildRewindTimeline(entries, 20);
  assert.equal(tl.length, 3);
  assert.deepEqual(tl.map((t) => t.turnNumber), [1, 2, 3]);
  assert.deepEqual(tl.map((t) => t.userEntryIndex), [0, 2, 5]);
  // turn 1 keeps [0,2); turn 2 keeps [0,5) (both its assistant entries); turn 3 keeps all 7
  assert.deepEqual(tl.map((t) => t.endIndex), [2, 5, 7]);
  assert.deepEqual(tl.map((t) => t.preview), ['first', 'second', 'third']);
});

test('0.4.x-3 buildRewindTimeline: windows to the last `max` turns, renumbered from 1', () => {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < 25; i++) { entries.push(u(`q${i}`, `t${i}`)); entries.push(a(`a${i}`)); }
  const tl = buildRewindTimeline(entries, 20);
  assert.equal(tl.length, 20);
  assert.equal(tl[0].turnNumber, 1);
  assert.equal(tl[0].preview, 'q5');     // oldest 5 dropped (25 - 20)
  assert.equal(tl[19].preview, 'q24');   // most recent
  // absoluteTurn is the stable 1-based ordinal among ALL user entries (keys the file-restore log).
  assert.equal(tl[0].absoluteTurn, 6);   // 6th user turn overall (turnNumber 1 in the window)
  assert.equal(tl[19].absoluteTurn, 25); // 25th overall
});

test('0.4.x-3 truncateAtTurn: keeps [0,endIndex), clamped', () => {
  const entries: TranscriptEntry[] = [u('a', 't'), a('b'), u('c', 't'), a('d')];
  assert.equal(truncateAtTurn(entries, 2).length, 2);
  assert.equal(truncateAtTurn(entries, 99).length, 4); // clamp high
  assert.equal(truncateAtTurn(entries, -1).length, 0); // clamp low
});
