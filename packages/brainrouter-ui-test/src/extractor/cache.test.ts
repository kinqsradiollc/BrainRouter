import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent, diffFiles, updateCache } from './cache.js';

test('unchanged hash → skipped; changed/new → re-walked', () => {
  const prev = { 'a.tsx': hashContent('AAA'), 'b.tsx': hashContent('BBB') };
  const files = [
    { path: 'a.tsx', text: 'AAA' }, // unchanged
    { path: 'b.tsx', text: 'BBB-edited' }, // changed
    { path: 'c.tsx', text: 'CCC' }, // new
  ];
  const d = diffFiles(prev, files);
  assert.deepEqual(d.unchangedPaths, ['a.tsx']);
  assert.deepEqual(d.changed.map((f) => f.path).sort(), ['b.tsx', 'c.tsx']);
  assert.deepEqual(d.removedPaths, []);
});

test('files absent from the set are reported removed', () => {
  const prev = { 'a.tsx': hashContent('AAA'), 'gone.tsx': hashContent('X') };
  const d = diffFiles(prev, [{ path: 'a.tsx', text: 'AAA' }]);
  assert.deepEqual(d.removedPaths, ['gone.tsx']);
});

test('updateCache keeps unchanged, updates changed, drops removed', () => {
  const prev = { 'a.tsx': hashContent('AAA'), 'gone.tsx': hashContent('X') };
  const next = updateCache(prev, [{ path: 'a.tsx', text: 'AAA2' }], ['gone.tsx']);
  assert.equal(next['a.tsx'], hashContent('AAA2'));
  assert.equal('gone.tsx' in next, false);
});
