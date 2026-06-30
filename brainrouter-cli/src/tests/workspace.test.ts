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
  grepSearch,
  parsePatchEnvelope,
  assessPatchSafety,
} from '@kinqs/brainrouter-core/agent';
import { findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { loadWorkspaceInstructionSummary } from '@kinqs/brainrouter-core/prompt';
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

test('FS-FIX grep_search matches a REGEX (alternation), not a literal substring', () => {
  withTempWorkspace(() => {
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync('src/a.ts', 'import sqlite from "x";\nconst y = 1;\n');
    fs.writeFileSync('src/b.ts', 'use better-sqlite3 here\n');
    const ws = fs.realpathSync(process.cwd());
    // The old literal `includes` searched for the raw string "sqlite|better-sqlite"
    // (with the pipe) and found nothing. As a regex it matches both files.
    const hits = grepSearch('sqlite|better-sqlite', ws, ws);
    assert.deepEqual(hits.map((h) => h.path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(hits.find((h) => h.path === 'src/a.ts')!.line, 1);
  });
});

test('FS-FIX grep_search accepts a single FILE path (no ENOTDIR)', () => {
  withTempWorkspace(() => {
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync('src/a.ts', 'hello\nworld\n');
    const ws = fs.realpathSync(process.cwd());
    // Previously `readdirSync(file)` threw ENOTDIR; now it greps just that file.
    const hits = grepSearch('world', path.join(ws, 'src/a.ts'), ws);
    assert.deepEqual(hits, [{ path: 'src/a.ts', line: 2, text: 'world' }]);
  });
});

test('FS-FIX grep_search falls back to literal on an invalid regex', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('a.txt', 'value a(b literal\n');
    const ws = fs.realpathSync(process.cwd());
    const hits = grepSearch('a(b', ws, ws); // '(' is invalid regex → literal fallback
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, 'a.txt');
  });
});

test('FS-FIX grep_search + globFiles skip .claude / .brainrouter (worktree copies)', () => {
  withTempWorkspace(() => {
    fs.mkdirSync('.claude/worktrees/copy', { recursive: true });
    fs.mkdirSync('.brainrouter/worktrees/copy', { recursive: true });
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync('.claude/worktrees/copy/dup.ts', 'NEEDLE\n');
    fs.writeFileSync('.brainrouter/worktrees/copy/dup.ts', 'NEEDLE\n');
    fs.writeFileSync('src/real.ts', 'NEEDLE\n');
    const ws = fs.realpathSync(process.cwd());
    assert.deepEqual(globFiles('**/*.ts'), ['src/real.ts'], 'glob skips repo copies');
    assert.deepEqual(grepSearch('NEEDLE', ws, ws).map((h) => h.path), ['src/real.ts'], 'grep skips repo copies');
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

test('CODEX-APPLY-PATCH-HARDEN atomic: a later op failure leaves NO earlier op applied', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('a.txt', 'aaa\n');
    fs.writeFileSync('b.txt', 'bbb\n');
    // Op 1 (a.txt) is valid; op 2 (b.txt) has non-matching context → whole
    // patch must abort with a.txt untouched (the partial-apply bug).
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '-aaa',
      '+AAA',
      '*** Update File: b.txt',
      '-does-not-match',
      '+nope',
      '*** End Patch',
    ].join('\n');
    assert.throws(() => applyPatchEnvelope(patch), /did not match/);
    // Atomicity: a.txt must still hold its ORIGINAL content (op 1 not flushed).
    assert.equal(fs.readFileSync('a.txt', 'utf8'), 'aaa\n');
    assert.equal(fs.readFileSync('b.txt', 'utf8'), 'bbb\n');
  });
});

test('CODEX-APPLY-PATCH-HARDEN atomic: an Add that collides aborts the whole patch', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('keep.txt', 'orig\n');
    fs.writeFileSync('exists.txt', 'already\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: keep.txt',
      '-orig',
      '+changed',
      '*** Add File: exists.txt', // collision → must abort
      '+new',
      '*** End Patch',
    ].join('\n');
    assert.throws(() => applyPatchEnvelope(patch), /already exists/);
    assert.equal(fs.readFileSync('keep.txt', 'utf8'), 'orig\n', 'earlier update must not have been flushed');
  });
});

test('CODEX-APPLY-PATCH-HARDEN Update + Move to renames the file with the new content', () => {
  withTempWorkspace(() => {
    fs.writeFileSync('old.txt', 'v1\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: old.txt',
      '*** Move to: new.txt',
      '-v1',
      '+v2',
      '*** End Patch',
    ].join('\n');
    const parsed = JSON.parse(applyPatchEnvelope(patch));
    assert.equal(parsed.applied[0].movedTo, 'new.txt');
    assert.equal(fs.existsSync('old.txt'), false, 'source removed after move');
    assert.equal(fs.readFileSync('new.txt', 'utf8'), 'v2\n');
  });
});

test('CODEX-APPLY-PATCH-HARDEN parser tolerates *** End of File and reports safety', () => {
  const ops = parsePatchEnvelope([
    '*** Begin Patch',
    '*** Add File: x.txt',
    '+hello',
    '*** End of File',
    '*** Delete File: y.txt',
    '*** End Patch',
  ].join('\n'));
  assert.equal(ops.length, 2);
  const safety = assessPatchSafety(ops);
  assert.equal(safety.adds, 1);
  assert.equal(safety.deletes, 1);
  assert.equal(safety.touchesVcs, false);
  // A patch touching .git is flagged for approval routing.
  const vcs = assessPatchSafety(parsePatchEnvelope([
    '*** Begin Patch',
    '*** Delete File: .git/hooks/pre-commit',
    '*** End Patch',
  ].join('\n')));
  assert.equal(vcs.touchesVcs, true);
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

test('findWorkspaceRoot treats CLAUDE.md as a workspace marker', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync('CLAUDE.md', '# Claude instructions\n');
    fs.mkdirSync('sub', { recursive: true });
    const info = findWorkspaceRoot(path.join(workspace, 'sub'));
    assert.equal(info.workspaceRoot, fs.realpathSync(workspace));
  });
});

test('loadWorkspaceInstructionSummary reads CLAUDE.md when present', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync('CLAUDE.md', '# Claude rules\nDo the thing.\n');
    assert.match(loadWorkspaceInstructionSummary(workspace) ?? '', /Do the thing/);
  });
});

test('loadWorkspaceInstructionSummary precedence: AGENT.md wins over CLAUDE.md', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync('AGENT.md', '# from AGENT\n');
    fs.writeFileSync('CLAUDE.md', '# from CLAUDE\n');
    assert.match(loadWorkspaceInstructionSummary(workspace) ?? '', /from AGENT/);
  });
});

test('loadWorkspaceInstructionSummary returns undefined when no instruction file exists', () => {
  withTempWorkspace((workspace) => {
    assert.equal(loadWorkspaceInstructionSummary(workspace), undefined);
  });
});
