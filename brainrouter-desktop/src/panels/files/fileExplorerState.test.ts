import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFileExplorerState, pruneFileExplorerState } from './fileExplorerState.js';

test('file explorer state parser bounds and sanitizes persisted presentation state', () => {
  const parsed = parseFileExplorerState(JSON.stringify({
    filter: 'x'.repeat(300),
    expanded: ['src', 'src', '../outside', '/absolute', 'a\\b'],
    selectedPath: '../secret',
  }));
  assert.equal(parsed.filter.length, 200);
  assert.deepEqual(parsed.expanded, ['src']);
  assert.equal(parsed.selectedPath, null);
});

test('file explorer state pruning keeps only paths in the active workspace tree', () => {
  const state = {
    filter: 'route',
    expanded: ['src', 'src/routes', 'old'],
    selectedPath: 'src/routes/home.ts',
  };
  assert.deepEqual(pruneFileExplorerState(state, [
    'src/routes/home.ts',
    'src/index.ts',
  ]), {
    filter: 'route',
    expanded: ['src', 'src/routes'],
    selectedPath: 'src/routes/home.ts',
  });
  assert.deepEqual(pruneFileExplorerState(state, ['README.md']), {
    filter: 'route',
    expanded: [],
    selectedPath: null,
  });
});
