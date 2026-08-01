import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  copyDeclaredPackageFiles,
  declaredPackageEntries,
} from './workspace-package-files.mjs';

test('packaged workspace copies declared runtime assets alongside dist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-workspace-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(source, 'dist', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(source, 'config', 'providers.json'), '{}\n');
  fs.writeFileSync(path.join(source, 'agents', 'engineering.json'), '{}\n');

  const copied = copyDeclaredPackageFiles(source, destination, {
    files: ['dist', '!dist/**/*.test.*', 'config', 'agents'],
  });

  assert.deepEqual(copied, ['dist', 'config', 'agents']);
  assert.equal(fs.readFileSync(path.join(destination, 'config', 'providers.json'), 'utf8'), '{}\n');
  assert.equal(fs.readFileSync(path.join(destination, 'agents', 'engineering.json'), 'utf8'), '{}\n');
});

test('packaged workspace rejects unsafe or ambiguous positive entries', () => {
  assert.throws(() => declaredPackageEntries({ files: ['../outside'] }), /Unsupported/);
  assert.throws(() => declaredPackageEntries({ files: ['runtime/*.json'] }), /Unsupported/);
});

test('packaged workspace fails when a declared runtime entry is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-workspace-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => copyDeclaredPackageFiles(root, path.join(root, 'destination'), { files: ['config'] }),
    /declares missing runtime entry/,
  );
});

test('packaged workspace rejects declared assets that escape through a link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-workspace-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(source);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.json'), '{}\n');
  fs.symlinkSync(outside, path.join(source, 'config'));

  assert.throws(
    () => copyDeclaredPackageFiles(source, path.join(root, 'destination'), { files: ['config'] }),
    /escapes its package/,
  );
});
