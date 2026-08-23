/**
 * ADR-042 S6 (D7) — prepareChildWorkspace attachTo: a child resumes an existing
 * worktree instead of minting a fresh detached copy. Refused when the target is
 * unlisted or owned by a live foreign session, unless fallback:'create'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareChildWorkspace } from '../worktree/isolation/worktreeIsolation.impl.js';
import { recordWorktreeOwner } from '../worktree/ownership/worktreeOwnership.js';

function git(cwd: string, ...a: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
}
const gitOk = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function scaffold(base: string) {
  const primary = path.join(base, 'main');
  const wt = path.join(base, 'feature');
  fs.mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
  git(primary, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { primary, wt: fs.realpathSync(wt) };
}

test('attachTo resumes an existing worktree by branch instead of minting', { skip: !gitOk }, () => {
  const prev = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-att-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  try {
    const { primary, wt } = scaffold(base);
    const res = prepareChildWorkspace({
      parentWorkspaceRoot: primary,
      parentLaunchCwd: primary,
      childId: 'c1',
      access: 'write',
      mode: 'git-worktree',
      attachTo: { branch: 'feature' },
      selfSessionKey: 'me',
    });
    assert.equal(res.isolated, true);
    assert.equal(res.workspaceRoot, wt, 'resumed the existing worktree, did not mint');
    assert.equal(res.isolation?.worktreeRoot, wt);
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prev;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('attachTo to an unlisted target fails, and fallback:create mints instead', { skip: !gitOk }, () => {
  const prev = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-att2-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  try {
    const { primary, wt } = scaffold(base);
    assert.throws(
      () => prepareChildWorkspace({
        parentWorkspaceRoot: primary, parentLaunchCwd: primary, childId: 'c2',
        access: 'write', mode: 'git-worktree', attachTo: { branch: 'nope' }, selfSessionKey: 'me',
      }),
      /attach to "nope" failed/,
    );
    // fallback:'create' mints a fresh detached worktree (not the feature one).
    const minted = prepareChildWorkspace({
      parentWorkspaceRoot: primary, parentLaunchCwd: primary, childId: 'c2',
      access: 'write', mode: 'git-worktree', attachTo: { branch: 'nope', fallback: 'create' }, selfSessionKey: 'me',
    });
    assert.equal(minted.isolated, true);
    assert.notEqual(minted.workspaceRoot, wt, 'minted a fresh worktree, not the feature one');
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prev;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('attachTo to a worktree owned by a live foreign session is refused', { skip: !gitOk }, () => {
  const prev = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-att3-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  try {
    const { primary, wt } = scaffold(base);
    recordWorktreeOwner(primary, wt, 'session-other'); // a live foreign owner
    assert.throws(
      () => prepareChildWorkspace({
        parentWorkspaceRoot: primary, parentLaunchCwd: primary, childId: 'c3',
        access: 'write', mode: 'git-worktree', attachTo: { branch: 'feature' }, selfSessionKey: 'session-me',
      }),
      /owned by a live session \(session-other\)/,
    );
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prev;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
