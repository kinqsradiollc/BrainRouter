/**
 * ADR-042 S2 — end-to-end: worktree_enter through the builtin runtime actually
 * WIDENS file resolution. A real git repo + a real linked worktree; before
 * entering, a read of the worktree's file escapes the jail; after entering, it
 * resolves. This is the whole point of the slice, exercised through the same
 * dispatch the agent uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';

function git(cwd: string, ...a: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
}
function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeCtx(primary: string) {
  return {
    workspaceRoot: primary,
    reviewSourceSafety: false,
    filesReadThisSession: new Set<string>(),
    maybeReindexSource: async () => {},
    _attached: [] as string[],
    get attachedRoots() { return this._attached; },
    get workspaceScope() { return { primaryRoot: this.workspaceRoot, attachedRoots: this._attached }; },
    attachWorktree(root: string) {
      let c = root; try { c = fs.realpathSync(root); } catch { /* keep */ }
      if (c === this.workspaceRoot) return;
      if (!this._attached.includes(c)) this._attached.push(c);
    },
  };
}

test('worktree_enter attaches a real linked worktree so its files resolve', { skip: !gitAvailable() }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-e2e-')));
  const primary = path.join(base, 'main');
  const wt = path.join(base, 'feature');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'in main\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-q', '-m', 'init');
    // A real linked worktree on a new branch.
    git(primary, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const wtFile = path.join(fs.realpathSync(wt), 'a.txt');

    const ctx = makeCtx(primary);

    // worktree_list sees the sibling by branch.
    const listed = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_list', {}));
    const names = listed.worktrees.map((w: any) => w.branch);
    assert.ok(names.includes('feature'), `feature worktree listed: ${JSON.stringify(names)}`);

    // BEFORE entering: reading the worktree's file escapes the jail.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'read_file', { path: wtFile }),
      /escapes workspace root/,
      'worktree file must be out of scope before entering',
    );

    // Enter by branch name.
    const entered = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_enter', { target: 'feature' }));
    assert.equal(path.resolve(entered.entered), path.resolve(wt));
    assert.equal(entered.branch, 'feature');
    assert.equal(ctx.attachedRoots.length, 1);

    // AFTER entering: the same read resolves.
    const content = await invokeBuiltinToolRuntime.call(ctx, 'read_file', { path: wtFile });
    assert.match(content, /in main/);

    // A path outside BOTH roots still escapes.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'read_file', { path: path.join(base, 'nope.txt') }),
      /escapes workspace root|File not found/,
    );
  } finally {
    // `git worktree add` locks the linked worktree's admin dir; rm is best-effort.
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('worktree_enter refuses an unrelated path', { skip: !gitAvailable() }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-e2e2-')));
  const primary = path.join(base, 'main');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
    const ctx = makeCtx(primary);
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'worktree_enter', { target: '/etc' }),
      /No git worktree of this repository/,
    );
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
