// Unit tests for the pure project (workspace) helpers behind the Projects screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectName, projectRows } from './projects.js';

test('projectName takes the last path segment (posix + windows)', () => {
  assert.equal(projectName('/Users/dev/BrainRouter'), 'BrainRouter');
  assert.equal(projectName('C:\\src\\my-app'), 'my-app');
  assert.equal(projectName('TradingAgents'), 'TradingAgents');
  assert.equal(projectName('/a/b/'), 'b'); // trailing slash ignored
  assert.equal(projectName(''), '(untitled)');
});

test('projectRows dedupes recents, names them, and flags the current one', () => {
  const rows = projectRows(['/a/foo', '/a/foo', '/b/bar'], '/b/bar');
  assert.deepEqual(rows, [
    { root: '/a/foo', name: 'foo', current: false },
    { root: '/b/bar', name: 'bar', current: true },
  ]);
});

test('projectRows skips blanks and handles a null current', () => {
  const rows = projectRows(['', '/x/one'], null);
  assert.deepEqual(rows, [{ root: '/x/one', name: 'one', current: false }]);
});
