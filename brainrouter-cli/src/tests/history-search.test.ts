import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHistory } from '../runtime/inputHistory.js';

const H = ['fix the bug', 'npm run build', 'fix the tests', 'git status', 'Fix typo in readme'];

test('searchHistory: newest-first, case-insensitive substring', () => {
  assert.deepEqual(searchHistory(H, 'fix'), { value: 'Fix typo in readme', index: 4 });
  assert.deepEqual(searchHistory(H, 'FIX', 1), { value: 'fix the tests', index: 2 });
  assert.deepEqual(searchHistory(H, 'fix', 2), { value: 'fix the bug', index: 0 });
});

test('searchHistory: skip past the last match → null (caller keeps prior view)', () => {
  assert.equal(searchHistory(H, 'fix', 3), null);
  assert.equal(searchHistory(H, 'zzz'), null);
});

test('searchHistory: empty/whitespace query → null', () => {
  assert.equal(searchHistory(H, ''), null);
  assert.equal(searchHistory(H, '   '), null);
});

test('searchHistory: mid-string matches count', () => {
  assert.deepEqual(searchHistory(H, 'run b'), { value: 'npm run build', index: 1 });
});
