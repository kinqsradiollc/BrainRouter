import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readExtensionManifest,
  discoverExtensionsIn,
  resolveExtensions,
  type ExtensionInfo,
} from '../extension/manifest.js';

function mkExt(root: string, name: string, manifest: Record<string, unknown>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest), 'utf-8');
  return dir;
}

test('readExtensionManifest: parses name/version/main/contributes; null on missing/malformed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ext-'));
  mkExt(root, 'good', { name: 'good', version: '1.2.3', main: 'main.js', contributes: ['tools'] });
  const info = readExtensionManifest(path.join(root, 'good'), 'user')!;
  assert.equal(info.name, 'good');
  assert.equal(info.version, '1.2.3');
  assert.ok(info.entry.endsWith('main.js'));
  assert.deepEqual(info.contributes, ['tools']);
  // missing manifest → null
  fs.mkdirSync(path.join(root, 'empty'));
  assert.equal(readExtensionManifest(path.join(root, 'empty'), 'user'), null);
  // malformed json → null
  const bad = path.join(root, 'bad');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'extension.json'), '{ not json', 'utf-8');
  assert.equal(readExtensionManifest(bad, 'user'), null);
});

test('resolveExtensions: workspace shadows user shadows built-in by name', () => {
  const found: ExtensionInfo[] = [
    { name: 'x', description: '', version: '0', source: 'builtin', dir: '/b/x', entry: '/b/x/index.js', contributes: [] },
    { name: 'x', description: '', version: '0', source: 'user', dir: '/u/x', entry: '/u/x/index.js', contributes: [] },
    { name: 'x', description: '', version: '0', source: 'workspace', dir: '/w/x', entry: '/w/x/index.js', contributes: [] },
    { name: 'y', description: '', version: '0', source: 'builtin', dir: '/b/y', entry: '/b/y/index.js', contributes: [] },
  ];
  const resolved = resolveExtensions(found);
  assert.equal(resolved.length, 2);
  assert.equal(resolved.find((e) => e.name === 'x')!.source, 'workspace', 'workspace wins');
  assert.equal(resolved.find((e) => e.name === 'y')!.source, 'builtin');
});

test('discoverExtensionsIn: only folders with a valid extension.json are returned, entry defaults to index.js', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ext-'));
  mkExt(root, 'a', { name: 'a' });
  fs.mkdirSync(path.join(root, 'not-an-ext')); // no manifest → ignored
  const found = discoverExtensionsIn(root, 'workspace');
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'a');
  assert.ok(found[0].entry.endsWith('index.js'));
});
