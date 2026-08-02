/**
 * ADR-027 D9.1 (P6-6) — expanding a review to unchanged neighbours.
 *
 * Two properties carry the weight: the selection is DETERMINISTIC (two runs
 * over one revision must pick the same files, or coverage stops being
 * comparable and a finding appearing or vanishing cannot be attributed), and a
 * budget-truncated run SAYS SO (otherwise it reads exactly like an exhaustive
 * one).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExpansion,
  describeExpansion,
  type ExpansionCandidate,
} from '../review/expansionPolicy.js';

const c = (path: string, role: ExpansionCandidate['role'], weight = 10): ExpansionCandidate =>
  ({ path, role, weight });

test('a file already in the diff is never re-included', () => {
  const selection = selectExpansion({
    changed: ['src/helper.ts'],
    candidates: [c('src/helper.ts', 'callee'), c('src/caller.ts', 'caller')],
    budget: 1_000,
  });
  assert.deepEqual(selection.included.map((f) => f.path), ['src/caller.ts']);
});

test('callees rank first — they answer whether a guard already exists', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('caller.ts', 'caller'), c('control.ts', 'negative-control'), c('callee.ts', 'callee')],
    budget: 1_000,
  });
  assert.deepEqual(selection.included.map((f) => f.path), ['callee.ts', 'control.ts', 'caller.ts']);
});

test('negative controls outrank callers under a tight budget', () => {
  // Knowing a pattern is conventional PREVENTS a wrong report; a missed caller
  // only costs a missed impact note. A false positive is the costlier failure.
  const selection = selectExpansion({
    changed: [],
    candidates: [c('caller.ts', 'caller', 10), c('control.ts', 'negative-control', 10)],
    budget: 10,
  });
  assert.deepEqual(selection.included.map((f) => f.path), ['control.ts']);
  assert.deepEqual(selection.dropped.map((f) => f.path), ['caller.ts']);
});

test('a file qualifying as several things keeps its highest-priority role', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('both.ts', 'caller'), c('both.ts', 'callee')],
    budget: 1_000,
  });
  assert.equal(selection.included.length, 1, 'deduped by path');
  assert.equal(selection.included[0]!.role, 'callee');
});

test('one oversized candidate does not starve everything behind it', () => {
  // A single huge callee consuming the budget would leave the review with no
  // context at all — worse than skipping the giant and taking three others.
  const selection = selectExpansion({
    changed: [],
    candidates: [
      c('huge.ts', 'callee', 900),
      c('a.ts', 'negative-control', 10),
      c('b.ts', 'negative-control', 10),
      c('c.ts', 'caller', 10),
    ],
    budget: 100,
  });
  assert.deepEqual(selection.included.map((f) => f.path).sort(), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(selection.dropped.map((f) => f.path), ['huge.ts']);
  assert.equal(selection.usedWeight, 30);
});

test('maxFiles caps the count independently of the budget', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('a.ts', 'callee', 1), c('b.ts', 'callee', 1), c('d.ts', 'callee', 1)],
    budget: 10_000,
    maxFiles: 2,
  });
  assert.equal(selection.included.length, 2);
  assert.equal(selection.dropped.length, 1);
  assert.equal(selection.complete, false);
});

test('selection is deterministic across identical inputs in any order', () => {
  const candidates = [
    c('z.ts', 'callee', 5), c('a.ts', 'callee', 5),
    c('m.ts', 'caller', 5), c('b.ts', 'negative-control', 5),
  ];
  const first = selectExpansion({ changed: [], candidates, budget: 1_000 });
  const shuffled = [candidates[2]!, candidates[0]!, candidates[3]!, candidates[1]!];
  const second = selectExpansion({ changed: [], candidates: shuffled, budget: 1_000 });
  assert.deepEqual(
    first.included.map((f) => f.path),
    second.included.map((f) => f.path),
    'input order must not change the outcome',
  );
  // Ties on role and weight break on path, so the order is fully specified.
  assert.deepEqual(first.included.map((f) => f.path), ['a.ts', 'z.ts', 'b.ts', 'm.ts']);
});

test('everything fitting reports complete, with no budget caveat', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('a.ts', 'callee', 1)],
    budget: 100,
  });
  assert.equal(selection.complete, true);
  const text = describeExpansion(selection);
  assert.match(text, /1 neighbouring file/);
  assert.doesNotMatch(text, /omitted/);
});

test('a truncated expansion states that its checks are incomplete', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('a.ts', 'callee', 10), c('b.ts', 'caller', 10)],
    budget: 10,
  });
  const text = describeExpansion(selection);
  assert.match(text, /omitted for budget/);
  assert.match(text, /incomplete/, 'a silent truncation reads as exhaustive coverage');
});

test('no candidates at all is stated plainly rather than implied', () => {
  const selection = selectExpansion({ changed: ['x.ts'], candidates: [], budget: 100 });
  assert.equal(selection.complete, true);
  assert.match(describeExpansion(selection), /No neighbouring files were available/);
});

test('a zero budget drops everything and says so', () => {
  const selection = selectExpansion({
    changed: [],
    candidates: [c('a.ts', 'callee', 1)],
    budget: 0,
  });
  assert.equal(selection.included.length, 0);
  assert.equal(selection.dropped.length, 1);
  assert.match(describeExpansion(selection), /No neighbouring files fit/);
});
