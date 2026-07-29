import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventorySourceTree, parseGitTreeEntries, type GitTreeEntry } from './inventory.js';

const roots: string[] = [];

async function sourceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assurance-inventory-'));
  roots.push(root);
  return root;
}

function entry(path: string, mode = '100644'): GitTreeEntry {
  return {
    mode,
    type: 'blob',
    objectId: 'a'.repeat(40),
    size: 8,
    path,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('excludes git symlink entries even when the host materializes them as regular files', async () => {
  const root = await sourceRoot();
  await writeFile(join(root, 'link'), 'target\n');
  const inventory = await inventorySourceTree(root, [entry('link', '120000')], { maxFiles: 10, maxBytes: 10_000 });

  expect(inventory.eligiblePaths).toEqual([]);
  expect(inventory.unsupportedFileCount).toBe(1);
  expect(inventory.limitations).toEqual([expect.objectContaining({ reasonCode: 'SOURCE_ENTRY_UNSUPPORTED' })]);
});

it.skipIf(process.platform === 'win32')('does not follow a symlink that replaces a regular tree entry', async () => {
  const root = await sourceRoot();
  await writeFile(join(root, 'outside'), 'secret\n');
  await symlink(join(root, 'outside'), join(root, 'source.ts'));
  const inventory = await inventorySourceTree(root, [entry('source.ts')], {
    maxFiles: 10,
    maxBytes: 10_000,
  });

  expect(inventory.eligiblePaths).toEqual([]);
  expect(inventory.unsupportedFileCount).toBe(1);
});

it('fails closed when a tree entry could escape the isolated source root', async () => {
  const root = await sourceRoot();
  await expect(inventorySourceTree(root, [entry('../outside.ts')], { maxFiles: 10, maxBytes: 10_000 })).rejects.toThrow(
    'SOURCE_PATH_ESCAPE',
  );
});

it('parses the canonical four-field long git tree format', () => {
  expect(parseGitTreeEntries(`100644 blob ${'a'.repeat(40)} 42\tpath with spaces.ts\0`)).toEqual([
    {
      mode: '100644',
      type: 'blob',
      objectId: 'a'.repeat(40),
      size: 42,
      path: 'path with spaces.ts',
    },
  ]);
});
