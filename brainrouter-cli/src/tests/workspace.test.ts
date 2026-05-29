import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPatchEnvelope,
  getToolPreview,
  globFiles,
  isPathInside,
  matchGlob,
  resolveWorkspacePath,
} from '../agent/agent.js';
import { findWorkspaceRoot } from '../config/workspace.js';
import { withTempWorkspace } from './_helpers.js';

test('resolveWorkspacePath rejects parent traversal outside workspace', () => {
  withTempWorkspace(() => {
    assert.throws(
      () => resolveWorkspacePath('../outside.txt'),
      /escapes workspace root/,
    );
  });
});

test('resolveWorkspacePath rejects absolute paths outside workspace', () => {
  withTempWorkspace(() => {
    assert.throws(
      () => resolveWorkspacePath(os.tmpdir()),
      /escapes workspace root/,
    );
  });
});

test('resolveWorkspacePath allows nested write targets inside workspace', () => {
  withTempWorkspace((workspace) => {
    const resolved = resolveWorkspacePath('src/new-file.ts', { forWrite: true });
    assert.equal(resolved, path.join(fs.realpathSync(workspace), 'src', 'new-file.ts'));
  });
});

test('resolveWorkspacePath uses the explicit workspace, not process.cwd()', async () => {
  withTempWorkspace((workspace) => {
    // Make a SECOND tmp dir and pretend it's the workspace; cwd is still the
    // first one. The function must honor the explicit workspace argument.
    const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-other-'));
    try {
      const resolved = resolveWorkspacePath(otherWorkspace, 'test/file.txt', { forWrite: true });
      assert.equal(resolved.startsWith(fs.realpathSync(otherWorkspace)), true);
      assert.equal(resolved.startsWith(fs.realpathSync(workspace)), false);
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});

test('isPathInside treats equal and nested paths as inside', () => {
  const root = path.resolve('/tmp/example');
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join(root, 'child')), true);
  assert.equal(isPathInside(root, path.resolve('/tmp/example-sibling')), false);
});

test('matchGlob handles recursive and basename patterns', () => {
  assert.equal(matchGlob('src/**/*.ts', 'src/index.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/cli/agent.ts'), true);
  assert.equal(matchGlob('*.md', 'README.md'), true);
  assert.equal(matchGlob('*.md', 'docs/README.md'), true);
  assert.equal(matchGlob('docs/*.md', 'src/README.md'), false);
});

test('globFiles ignores generated directories and returns workspace-relative matches', () => {
  withTempWorkspace(() => {
    fs.mkdirSync('src', { recursive: true });
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('src/index.ts', 'export {};\n');
    fs.writeFileSync('dist/index.ts', 'export {};\n');

    assert.deepEqual(globFiles('**/*.ts'), ['src/index.ts']);
  });
});

test('getToolPreview renders list_dir entries with type icons and sizes', () => {
  const result = JSON.stringify([
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file', size: 1536 },
    { name: 'binary.bin', type: 'file', size: 2 * 1024 * 1024 },
  ]);
  const preview = getToolPreview('list_dir', { path: '.' }, result);
  assert.ok(preview);
  assert.match(preview!, /📁 src/);
  assert.match(preview!, /📄 README\.md \(1\.5 KB\)/);
  assert.match(preview!, /📄 binary\.bin \(2\.0 MB\)/);
});

test('getToolPreview truncates list_dir to a cap with overflow notice', () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ name: `f${i}.ts`, type: 'file', size: 10 }));
  const preview = getToolPreview('list_dir', {}, JSON.stringify(items));
  assert.ok(preview);
  assert.match(preview!, /…and 15 more/);
});

test('getToolPreview signals an empty list_dir without crashing', () => {
  assert.equal(getToolPreview('list_dir', {}, '[]'), '(empty directory)');
});

test('getToolPreview formats grep_search matches with file:line:text', () => {
  const matches = JSON.stringify([
    { path: 'src/foo.ts', line: 42, text: 'const x = 1;' },
    { path: 'src/bar.ts', line: 7, text: 'function bar() {}' },
  ]);
  const preview = getToolPreview('grep_search', { query: 'x' }, matches);
  assert.ok(preview);
  assert.match(preview!, /src\/foo\.ts:42\s+const x = 1;/);
  assert.match(preview!, /src\/bar\.ts:7\s+function bar/);
});

test('getToolPreview lists glob_files paths and caps with overflow notice', () => {
  const paths = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
  const preview = getToolPreview('glob_files', { pattern: 'src/**/*.ts' }, JSON.stringify(paths));
  assert.ok(preview);
  assert.match(preview!, /src\/file-0\.ts/);
  assert.match(preview!, /…and 5 more/);
});

test('getToolPreview returns undefined for tools without an inline preview', () => {
  assert.equal(getToolPreview('read_file', { path: 'x' }, 'file contents'), undefined);
  assert.equal(getToolPreview('run_command', { command: 'ls' }, 'output'), undefined);
});

test('getToolPreview returns undefined when result JSON is malformed', () => {
  assert.equal(getToolPreview('list_dir', {}, 'not-json'), undefined);
  assert.equal(getToolPreview('grep_search', { query: 'x' }, 'not-json'), undefined);
});

test('applyPatchEnvelope handles update, add, and delete operations in one envelope', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('alpha.txt', 'hello world\n');
    fs.writeFileSync('legacy.txt', 'remove me\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: alpha.txt',
      '-hello world',
      '+hello BrainRouter',
      '*** Add File: notes/new.md',
      '+# New file',
      '+Created by apply_patch.',
      '*** Delete File: legacy.txt',
      '*** End Patch',
    ].join('\n');
    const result = applyPatchEnvelope(patch);
    const parsed = JSON.parse(result);
    assert.equal(parsed.applied.length, 3);
    assert.equal(fs.readFileSync('alpha.txt', 'utf8'), 'hello BrainRouter\n');
    assert.equal(fs.readFileSync('notes/new.md', 'utf8'), '# New file\nCreated by apply_patch.');
    assert.equal(fs.existsSync('legacy.txt'), false);
  });
});

test('applyPatchEnvelope rejects malformed envelopes and ambiguous context', () => {
  withTempWorkspace(() => {
    assert.throws(() => applyPatchEnvelope('not a patch'), /Begin Patch/);
    fs.writeFileSync('dup.txt', 'same\nsame\n');
    const ambiguous = [
      '*** Begin Patch',
      '*** Update File: dup.txt',
      '-same',
      '+changed',
      '*** End Patch',
    ].join('\n');
    assert.throws(() => applyPatchEnvelope(ambiguous), /matched 2 times/);
  });
});

test('applyPatchEnvelope (MAS-P3) refuses writes outside the ownership glob, atomically', () => {
  withTempWorkspace((ws) => {
    fs.mkdirSync('src/owned', { recursive: true });
    fs.writeFileSync('src/owned/a.txt', 'old\n');
    // A patch that touches an in-bounds file AND an out-of-bounds file.
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/owned/a.txt',
      '-old',
      '+new',
      '*** Add File: src/other/c.txt',
      '+sneaky',
      '*** End Patch',
    ].join('\n');
    assert.throws(
      () => applyPatchEnvelope(patch, ws, 'src/owned/**'),
      /ownership boundary "src\/owned\/\*\*"/,
    );
    // Atomic: the in-bounds file must NOT have been modified, and the
    // out-of-bounds add must NOT exist — the whole patch is rejected up front.
    assert.equal(fs.readFileSync('src/owned/a.txt', 'utf8'), 'old\n');
    assert.equal(fs.existsSync('src/other/c.txt'), false);
  });
});

test('applyPatchEnvelope (MAS-P3) allows writes inside the ownership glob', () => {
  withTempWorkspace((ws) => {
    fs.mkdirSync('src/owned', { recursive: true });
    fs.writeFileSync('src/owned/a.txt', 'old\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/owned/a.txt',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const parsed = JSON.parse(applyPatchEnvelope(patch, ws, 'src/owned/**'));
    assert.equal(parsed.applied.length, 1);
    assert.equal(fs.readFileSync('src/owned/a.txt', 'utf8'), 'new\n');
  });
});

test('findWorkspaceRoot promotes BrainRouter package cwd to parent monorepo', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync('AGENT.md', '# Root instructions\n');
    fs.writeFileSync('package.json', JSON.stringify({ workspaces: ['brainrouter'] }));
    fs.mkdirSync('brainrouter', { recursive: true });
    fs.writeFileSync(path.join('brainrouter', 'package.json'), JSON.stringify({ name: 'brainrouter' }));

    const info = findWorkspaceRoot(path.join(workspace, 'brainrouter'));
    assert.equal(info.workspaceRoot, fs.realpathSync(workspace));
    assert.match(info.reason, /workspace/);
  });
});
