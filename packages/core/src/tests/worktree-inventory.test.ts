/**
 * ADR-042 S2 — structured worktree inventory + the D2 derivation rule.
 * Pure parser + decision over a fake porcelain host; no git required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseWorktreePorcelainStructured,
  listWorktreesStructured,
  resolveAttachableWorktree,
  type WorktreeAwarenessHost,
} from '../worktree/concurrentWorktrees.js';

const SELF = '/repo/main';
const PORCELAIN = [
  'worktree /repo/main',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/feature-x',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature-x',
  '',
  'worktree /repo/detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /repo/locked-wt',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/locked-branch',
  'locked cleaning up',
  '',
  'worktree /repo/gone',
  'HEAD 5555555555555555555555555555555555555555',
  'branch refs/heads/gone-branch',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

const fakeHost: WorktreeAwarenessHost = {
  listPorcelain: () => PORCELAIN,
  isDirty: (p) => p === '/repo/feature-x',
};

test('parseWorktreePorcelainStructured captures branch/detached/locked/prunable + isSelf', () => {
  const list = parseWorktreePorcelainStructured(PORCELAIN, SELF);
  assert.equal(list.length, 5);
  const main = list.find((w) => w.path === '/repo/main')!;
  assert.equal(main.isSelf, true);
  assert.equal(main.branch, 'main');
  const feat = list.find((w) => w.path === '/repo/feature-x')!;
  assert.equal(feat.branch, 'feature-x');
  assert.equal(feat.isSelf, false);
  const det = list.find((w) => w.path === '/repo/detached')!;
  assert.equal(det.detached, true);
  assert.equal(det.branch, null);
  const locked = list.find((w) => w.path === '/repo/locked-wt')!;
  assert.equal(locked.locked, true);
  assert.equal(locked.lockedReason, 'cleaning up');
  const gone = list.find((w) => w.path === '/repo/gone')!;
  assert.equal(gone.prunable, true);
  assert.match(gone.prunableReason ?? '', /non-existent/);
});

test('listWorktreesStructured fills best-effort dirty only when asked', () => {
  const plain = listWorktreesStructured(SELF, fakeHost);
  assert.equal(plain.every((w) => w.dirty === undefined), true, 'no dirty without opt-in');
  const withDirty = listWorktreesStructured(SELF, fakeHost, { withDirty: true });
  assert.equal(withDirty.find((w) => w.path === '/repo/feature-x')!.dirty, true);
  assert.equal(withDirty.find((w) => w.path === '/repo/main')!.dirty, false);
  // Prunable entries are never status-probed.
  assert.equal(withDirty.find((w) => w.path === '/repo/gone')!.dirty, undefined);
});

test('resolveAttachableWorktree: derivation accepts a listed sibling by path AND by branch', () => {
  const byPath = resolveAttachableWorktree(SELF, '/repo/feature-x', fakeHost);
  assert.equal(byPath.ok, true);
  const byBranch = resolveAttachableWorktree(SELF, 'feature-x', fakeHost);
  assert.equal(byBranch.ok, true);
  assert.equal(byBranch.ok && byBranch.info.path, '/repo/feature-x');
});

test('resolveAttachableWorktree: refuses self, unlisted, and prunable with a reason + fix', () => {
  const self = resolveAttachableWorktree(SELF, '/repo/main', fakeHost);
  assert.equal(self.ok, false);
  assert.match(!self.ok ? self.reason : '', /already active/);

  const stranger = resolveAttachableWorktree(SELF, '/somewhere/else', fakeHost);
  assert.equal(stranger.ok, false);
  assert.match(!stranger.ok ? stranger.reason : '', /No git worktree of this repository/);

  const prunable = resolveAttachableWorktree(SELF, 'gone-branch', fakeHost);
  assert.equal(prunable.ok, false);
  assert.match(!prunable.ok ? prunable.reason : '', /git worktree prune/);
});

test('resolveAttachableWorktree: empty target and non-repo both refuse cleanly', () => {
  assert.equal(resolveAttachableWorktree(SELF, '   ', fakeHost).ok, false);
  const noRepo = resolveAttachableWorktree(SELF, 'x', { listPorcelain: () => { throw new Error('not a repo'); } });
  assert.equal(noRepo.ok, false);
  assert.match(!noRepo.ok ? noRepo.reason : '', /No git worktrees/);
});
