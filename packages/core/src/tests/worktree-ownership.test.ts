/**
 * ADR-042 D6 — the ownership registry (pure core) + end-to-end read-only foreign
 * attach through the runtime: a worktree a LIVE foreign session owns attaches
 * read-only — reads resolve, writes are refused with the owner named.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  recordWorktreeOwnerIn,
  clearWorktreeOwnerIn,
  liveForeignOwnerIn,
  recordWorktreeOwner,
  OWNER_STALE_MS,
} from '../worktree/ownership/worktreeOwnership.js';
import { isPathInside } from '../agent/fs/workspaceFs.js';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';

test('ownership registry: self is not foreign, a live foreign owner is named, stale + cleared are null', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-own-')));
  const file = path.join(dir, 'owners.json');
  const wt = '/repo/feature';
  const now = 1_000_000_000;
  try {
    recordWorktreeOwnerIn(file, wt, 'session-me', now);
    assert.equal(liveForeignOwnerIn(file, wt, 'session-me', now), null, 'own session is not foreign');

    recordWorktreeOwnerIn(file, wt, 'session-other', now);
    assert.equal(liveForeignOwnerIn(file, wt, 'session-me', now), 'session-other', 'live foreign owner named');

    assert.equal(liveForeignOwnerIn(file, wt, 'session-me', now + OWNER_STALE_MS + 1), null, 'stale owner ignored');

    clearWorktreeOwnerIn(file, wt);
    assert.equal(liveForeignOwnerIn(file, wt, 'session-me', now), null, 'cleared owner gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...a: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000,
  });
}
const gitOk = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function makeCtx(primary: string, sessionKey: string) {
  const ro = new Map<string, string>();
  return {
    workspaceRoot: primary,
    sessionKey,
    reviewSourceSafety: false,
    ownership: undefined,
    filesReadThisSession: new Set<string>(),
    maybeReindexSource: async () => {},
    _attached: [] as string[],
    get attachedRoots() { return this._attached; },
    get workspaceScope() { return { primaryRoot: this.workspaceRoot, attachedRoots: this._attached, readOnlyRoots: [...ro.keys()] }; },
    attachWorktree(root: string) { let c = root; try { c = fs.realpathSync(root); } catch { /* keep */ } if (c !== this.workspaceRoot && !this._attached.includes(c)) this._attached.push(c); },
    attachReadOnlyWorktree(root: string, owner: string) { let c = root; try { c = fs.realpathSync(root); } catch { /* keep */ } if (c === this.workspaceRoot) return; this._attached = this._attached.filter((r) => r !== c); ro.set(c, owner); },
    readOnlyWorktreeOwner(inputPath: string) { if (ro.size === 0 || typeof inputPath !== 'string' || !inputPath.trim()) return null; const abs = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(this.workspaceRoot, inputPath); for (const [r, o] of ro) { if (isPathInside(r, abs)) return o; } return null; },
    detachWorktree(root: string) { let c = root; try { c = fs.realpathSync(root); } catch { /* keep */ } this._attached = this._attached.filter((r) => r !== c && r !== root); ro.delete(c); },
  };
}

test('worktree_enter attaches read-only when a live foreign session owns it; reads work, writes are refused', { skip: !gitOk }, async () => {
  const prevHome = process.env.BRAINROUTER_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adr042-ro-')));
  process.env.BRAINROUTER_HOME = path.join(base, 'home');
  const primary = path.join(base, 'main');
  const wt = path.join(base, 'feature');
  try {
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(primary, 'a.txt'), 'x\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-q', '-m', 'init');
    git(primary, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const wtReal = fs.realpathSync(wt);
    const wtFile = path.join(wtReal, 'a.txt');

    // A LIVE FOREIGN session already owns the worktree.
    recordWorktreeOwner(primary, wtReal, 'session-other');

    const ctx = makeCtx(primary, 'session-me');
    const entered = JSON.parse(await invokeBuiltinToolRuntime.call(ctx, 'worktree_enter', { target: 'feature' }));
    assert.equal(entered.readOnly, true);
    assert.equal(entered.owner, 'session-other');
    assert.equal(ctx.attachedRoots.length, 0, 'not read/write attached');

    // Read works.
    const content = await invokeBuiltinToolRuntime.call(ctx, 'read_file', { path: wtFile });
    assert.match(content, /x/);

    // Write is refused with the owner named.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'write_file', { path: wtFile, content: 'nope' }),
      /owned by session session-other/,
    );
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(ctx, 'edit_file', { path: wtFile, old_string: 'x', new_string: 'y' }),
      /owned by session session-other/,
    );

    // override:true takes it read/write.
    const ctx2 = makeCtx(primary, 'session-me');
    const over = JSON.parse(await invokeBuiltinToolRuntime.call(ctx2, 'worktree_enter', { target: 'feature', override: true }));
    assert.notEqual(over.readOnly, true);
    assert.equal(ctx2.attachedRoots.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
