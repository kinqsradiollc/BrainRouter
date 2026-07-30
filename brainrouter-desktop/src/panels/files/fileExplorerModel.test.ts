import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFileTree,
  calculateVirtualRowWindow,
  FILE_TREE_ROW_HEIGHT,
  flattenVisibleFileTree,
} from './fileExplorerModel.js';

test('visible file-tree rows preserve sorted hierarchy and expansion state', () => {
  const tree = buildFileTree([
    'src/z.ts',
    'README.md',
    'src/components/Button.tsx',
    'src/a.ts',
  ]);

  assert.deepEqual(flattenVisibleFileTree(tree, new Set(['src', 'src/components'])), [
    { kind: 'directory', path: 'src', name: 'src', depth: 0, expanded: true },
    { kind: 'directory', path: 'src/components', name: 'components', depth: 1, expanded: true },
    { kind: 'file', path: 'src/components/Button.tsx', name: 'Button.tsx', depth: 2 },
    { kind: 'file', path: 'src/a.ts', name: 'a.ts', depth: 1 },
    { kind: 'file', path: 'src/z.ts', name: 'z.ts', depth: 1 },
    { kind: 'file', path: 'README.md', name: 'README.md', depth: 0 },
  ]);
});

test('large file trees expose a bounded render window', () => {
  const window = calculateVirtualRowWindow(25_000, 120_000, 720);
  assert.equal(window.virtualized, true);
  assert.equal(window.totalHeight, 25_000 * FILE_TREE_ROW_HEIGHT);
  assert.ok(window.start > 0);
  assert.ok(window.end - window.start <= 46);
});

test('representative 25k-file indexing stays bounded before rendering', () => {
  const paths = Array.from(
    { length: 25_000 },
    (_, index) => `packages/package-${Math.floor(index / 250)}/src/file-${index}.ts`,
  );
  const startedAt = performance.now();
  const tree = buildFileTree(paths);
  const rows = flattenVisibleFileTree(
    tree,
    new Set([
      'packages',
      ...Array.from({ length: 100 }, (_, index) => `packages/package-${index}`),
      ...Array.from({ length: 100 }, (_, index) => `packages/package-${index}/src`),
    ]),
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(rows.filter((row) => row.kind === 'file').length, 25_000);
  assert.ok(elapsedMs < 2_000, `25k-file tree took ${elapsedMs.toFixed(1)}ms`);
  const window = calculateVirtualRowWindow(rows.length, 0, 720);
  assert.ok(window.end - window.start <= 46);
});
