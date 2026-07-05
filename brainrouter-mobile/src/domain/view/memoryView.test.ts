import test from 'node:test';
import assert from 'node:assert/strict';
import type { RecalledMemory } from '@kinqs/brainrouter-types';
import {
  sortByScore, scorePercent, memoryTypeLabel, isStale, memoryCounts, contentSnippet,
} from './memoryView.js';

const mem = (over: Partial<RecalledMemory>): RecalledMemory => ({
  content: 'A recalled memory',
  score: 0.5,
  type: 'codebase_fact',
  recordId: 'mem_0001',
  ...over,
});

test('sortByScore orders highest-score first, stable, non-mutating', () => {
  const list = [mem({ recordId: 'a', score: 0.2 }), mem({ recordId: 'b', score: 0.9 }), mem({ recordId: 'c', score: 0.5 })];
  assert.deepEqual(sortByScore(list).map((m) => m.recordId), ['b', 'c', 'a']);
  assert.deepEqual(list.map((m) => m.recordId), ['a', 'b', 'c'], 'input untouched');
});

test('scorePercent renders a clamped integer percent', () => {
  assert.equal(scorePercent(0.874), '87%');
  assert.equal(scorePercent(0), '0%');
  assert.equal(scorePercent(1), '100%');
  assert.equal(scorePercent(1.4), '100%');
  assert.equal(scorePercent(-0.2), '0%');
});

test('memoryTypeLabel humanizes the snake_case type', () => {
  assert.equal(memoryTypeLabel('codebase_fact'), 'Codebase fact');
  assert.equal(memoryTypeLabel('architecture_decision'), 'Architecture decision');
  assert.equal(memoryTypeLabel(''), '');
});

test('isStale + memoryCounts flag stale-vs-code records', () => {
  const list = [mem({ staleVsCode: true }), mem({}), mem({ staleVsCode: false })];
  assert.equal(isStale(list[0]), true);
  assert.equal(isStale(list[1]), false);
  assert.deepEqual(memoryCounts(list), { total: 3, stale: 1 });
});

test('contentSnippet collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(contentSnippet('  a\n b  c '), 'a b c');
  const snip = contentSnippet('x'.repeat(200), 140);
  assert.equal(snip.length, 140);
  assert.ok(snip.endsWith('…'));
});
