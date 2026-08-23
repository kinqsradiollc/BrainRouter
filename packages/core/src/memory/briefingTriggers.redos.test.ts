import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFilePathHints, countEntityTokens } from './briefingTriggers.js';

// ADR-039 — the file-path heuristic runs over an attacker-controllable prompt /
// PR-comment body on the shared-brain briefing/recall path. Before the guard the
// path regex backtracked quadratically (~6s on 40k chars, ~23s on a real comment).
test('ADR-039: extractFilePathHints preserves real hints and is linear on a pathological run', () => {
  const legit = 'see src/foo/bar.ts and assets/logo.png plus config.json and docs/notes.md';
  assert.deepEqual(extractFilePathHints(legit), [
    'src/foo/bar.ts', 'assets/logo.png', 'config.json', 'docs/notes.md',
  ]);

  const evil = '.'.repeat(80_000); // one unbroken run; stalled the brain before the guard
  const start = performance.now();
  assert.deepEqual(extractFilePathHints(evil), []);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `expected linear time, took ${elapsed.toFixed(0)}ms`);
});

test('ADR-039: countEntityTokens counts real paths and is linear on a pathological run', () => {
  assert.equal(countEntityTokens('touch src/a.ts and lib/b.js here'), 2);

  const evil = 'a-'.repeat(50_000);
  const start = performance.now();
  const n = countEntityTokens(evil);
  assert.equal(typeof n, 'number');
  assert.ok(performance.now() - start < 1000, 'countEntityTokens must not backtrack');
});
