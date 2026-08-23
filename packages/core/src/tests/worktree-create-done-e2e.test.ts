/**
 * ADR-042 S4 (D3) — worktree_create / worktree_done through the real runtime on
 * a real git repo. Create a named-branch worktree (attached), then finish it:
 * a clean worktree removes; a dirty one is preserved unless force is set.
 * BRAINROUTER_HOME is redirected so the worktree base stays out of ~/.
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
    silent: false,
    // An authorizing user intent so the destructive-command guard on
    // `git worktree remove` resolves to allow (no interactive confirm in-test).
    lastUserPrompt: 'please finish the worktree when done',
    agentAuthoredCommits: new Set<string>(),
    interactionPort: undefined,
    prompter: undefined,
    _attached: [] as string[],
    get attachedRoots() { return this._attached; },
    get workspaceScope() { return { primaryRoot: this.workspaceRoot, attachedRoots: this._attached }; },
    attachWorktree(root: string) {
      let c = root; try { c = fs.realpathSync(root); } catch { /* keep */ }
      if (c !== this.workspaceRoot && !this._attached.includes(c)) this._attached.push(c);
    },
    detachWorktree(root: string) {
      let c = root; try { c = fs.realpathSync(root); } catch { /* gone */ }
      this._attached = this._attached.filter((r) => r !== c && r !== root);
    },
  };
}

test('worktree_create makes a named-branch worktree; worktree_done removes it clean and preserves dirty', { skip: !gitAvailable() }, async () => {
  const prevHome = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-cd-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  const primary = path.join(base, 'repo');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
    const ctx = makeCtx(primary);

    // Create — named branch, attached.
    const created = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_create', { branch: 'feature-x' }));
    assert.equal(created.branch, 'feature-x');
    assert.ok(fs.existsSync(created.created), 'worktree dir exists');
    assert.equal(ctx.attachedRoots.length, 1, 'attached on create');
    // git registered it.
    const list1 = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_list', {}));
    assert.ok(list1.worktrees.some((w: any) => w.branch === 'feature-x'));

    // Done — clean worktree removes and detaches.
    const done1 = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_done', { path: created.created }));
    assert.equal(done1.removed, true);
    assert.equal(fs.existsSync(created.created), false, 'worktree dir gone');
    assert.equal(ctx.attachedRoots.length, 0, 'detached on done');

    // Create again, dirty it, and confirm done PRESERVES it without force.
    const created2 = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_create', { branch: 'feature-y' }));
    fs.writeFileSync(path.join(created2.created, 'a.txt'), 'dirty change\n');
    const refused = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_done', { path: created2.created }));
    assert.equal(refused.removed, false);
    assert.match(refused.reason, /uncommitted/i);
    assert.equal(fs.existsSync(created2.created), true, 'dirty worktree preserved');

    // force:true discards and removes.
    const forced = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_done', { path: created2.created, force: true }));
    assert.equal(forced.removed, true);
    assert.equal(fs.existsSync(created2.created), false);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('worktree_create refuses an invalid branch name', { skip: !gitAvailable() }, async () => {
  const prevHome = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-cd2-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  const primary = path.join(base, 'repo');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
    const ctx = makeCtx(primary);
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'worktree_create', { branch: '../evil' }),
      /Invalid branch name/,
    );
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
