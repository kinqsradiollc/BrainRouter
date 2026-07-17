import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreeList, isValidWorktreeName } from './worktreeParser.js';

const SAMPLE = [
  'worktree /repo/main',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/feature',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature-x',
  '',
  'worktree /repo/.worktrees/hotfix',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n');

test('parses multiple worktrees with branch + detached', () => {
  const wts = parseWorktreeList(SAMPLE);
  assert.equal(wts.length, 3);
  assert.deepEqual(wts.map((w) => w.path), ['/repo/main', '/repo/.worktrees/feature', '/repo/.worktrees/hotfix']);
  assert.equal(wts[0].branch, 'main');
  assert.equal(wts[1].branch, 'feature-x');
  assert.equal(wts[2].branch, undefined);
  assert.equal(wts[2].isDetached, true);
});

test('the first worktree is flagged as main', () => {
  const wts = parseWorktreeList(SAMPLE);
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[1].isMain, false);
});

test('currentPath marks the open worktree (trailing-slash tolerant)', () => {
  const wts = parseWorktreeList(SAMPLE, '/repo/.worktrees/feature/');
  assert.deepEqual(wts.map((w) => w.isCurrent), [false, true, false]);
});

test('strips refs/heads/ prefix from branch names', () => {
  const wts = parseWorktreeList('worktree /r\nHEAD abc\nbranch refs/heads/release/0.4.15\n');
  assert.equal(wts[0].branch, 'release/0.4.15');
});

test('handles a bare main repo entry', () => {
  const wts = parseWorktreeList('worktree /r/bare\nbare\n\nworktree /r/wt\nHEAD a\nbranch refs/heads/x\n');
  assert.equal(wts[0].isBare, true);
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[1].branch, 'x');
});

test('empty output → no entries', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList('\n\n'), []);
});

test('worktree name validation rejects path traversal and shell metachars', () => {
  assert.equal(isValidWorktreeName('feature-1'), true);
  assert.equal(isValidWorktreeName('fix_2.0'), true);
  assert.equal(isValidWorktreeName('../escape'), false);
  assert.equal(isValidWorktreeName('a b'), false);
  assert.equal(isValidWorktreeName('a;rm -rf'), false);
  assert.equal(isValidWorktreeName(''), false);
});
