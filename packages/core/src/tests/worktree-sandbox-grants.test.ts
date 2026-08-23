/**
 * ADR-042 S3 (D4) — a sandboxed command in a LINKED worktree gets exactly the
 * two git write grants it needs (shared gitdir + private gitdir), and nothing
 * more. A real git worktree; asserts through the public resolveSandboxConfig.
 * This is the direct fix for `operation not permitted` on `git commit` inside a
 * worktree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSandboxConfig } from '../exec/runtime/sandbox.js';

function git(cwd: string, ...a: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
}
function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

test('resolveSandboxConfig grants a linked worktree its shared + private gitdir', { skip: !gitAvailable() }, () => {
  const base = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-sbx-')));
  const primary = path.join(base, 'main');
  const wt = path.join(base, 'feature');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
    git(primary, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const wtReal = real(wt);

    // Linked worktree: grants include the shared .git AND the private gitdir.
    const wtCfg = resolveSandboxConfig(wtReal);
    const sharedGit = real(path.join(primary, '.git'));
    assert.ok(
      wtCfg.writePaths.some((p) => p === sharedGit),
      `shared gitdir granted (${sharedGit}) in ${JSON.stringify(wtCfg.writePaths)}`,
    );
    assert.ok(
      wtCfg.writePaths.some((p) => p.includes(`${path.sep}worktrees${path.sep}`)),
      `private worktree gitdir granted in ${JSON.stringify(wtCfg.writePaths)}`,
    );

    // Main worktree: .git is a directory inside the root — no EXTERNAL grant added.
    const mainCfg = resolveSandboxConfig(real(primary));
    assert.equal(
      mainCfg.writePaths.some((p) => p.includes(`${path.sep}worktrees${path.sep}`)),
      false,
      'main worktree adds no private-gitdir grant',
    );
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('resolveSandboxConfig adds no git grants for a non-repo dir (no throw)', () => {
  const d = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-nonrepo-')));
  try {
    const cfg = resolveSandboxConfig(d);
    assert.equal(cfg.writePaths.some((p) => p.includes('worktrees')), false);
  } finally {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
