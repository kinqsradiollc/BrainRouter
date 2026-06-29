import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Isolate the per-session checkpoint store under a throwaway home (same pattern
// as usage-history.test.ts). Set BEFORE importing the store module.
process.env.BRAINROUTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ckpt-home-'));

const { createGitCheckpoint, restoreGitCheckpoint, isGitRepo } = await import('../git/checkpoint.js');
const { recordTurnCheckpoint, readTurnCheckpoint, listTurnCheckpoints, rollbackToTurnCheckpoint, pruneTurnCheckpointsAfter } =
  await import('../git/checkpointStore.js');

function git(dir: string, args: string[]) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}
function initRepo(): string {
  // realpath so the path matches git's view (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-ckpt-repo-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@brainrouter.dev']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
function commitAll(dir: string, msg: string) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
function write(dir: string, rel: string, content: string) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const externalCpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'br-cp-'));

test('createGitCheckpoint: null for a non-git directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-nogit-'));
  assert.equal(isGitRepo(dir), false);
  assert.equal(createGitCheckpoint(dir, path.join(externalCpDir(), 'cp')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkpoint + restore: reverts tracked edits and removes new untracked files', () => {
  const repo = initRepo();
  write(repo, 'a.txt', 'original\n');
  commitAll(repo, 'init');
  const cp = createGitCheckpoint(repo, externalCpDir())!;
  assert.ok(cp && cp.headSha.length >= 7);
  assert.equal(cp.hasWorkingPatch, false);
  assert.deepEqual(cp.untracked, []);

  // mutate after the checkpoint
  write(repo, 'a.txt', 'CHANGED\n');
  write(repo, 'new-untracked.txt', 'junk\n');

  const r = restoreGitCheckpoint(repo, cp);
  assert.equal(r.ok, true, r.error);
  assert.equal(read(repo, 'a.txt'), 'original\n', 'tracked edit reverted');
  assert.equal(fs.existsSync(path.join(repo, 'new-untracked.txt')), false, 'new untracked removed');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkpoint captures pre-existing uncommitted + untracked, and restores exactly that state', () => {
  const repo = initRepo();
  write(repo, 'a.txt', 'base\n');
  commitAll(repo, 'init');
  // dirty state at checkpoint time: a tracked edit + an untracked file
  write(repo, 'a.txt', 'edited-at-checkpoint\n');
  write(repo, 'note.md', 'keep me\n');
  const cp = createGitCheckpoint(repo, externalCpDir())!;
  assert.equal(cp.hasWorkingPatch, true);
  assert.deepEqual(cp.untracked, ['note.md']);

  // diverge further: change the tracked file again, delete the untracked one, add a new one
  write(repo, 'a.txt', 'later-edit\n');
  fs.rmSync(path.join(repo, 'note.md'));
  write(repo, 'extra.txt', 'should be removed on restore\n');

  const r = restoreGitCheckpoint(repo, cp);
  assert.equal(r.ok, true, r.error);
  assert.equal(read(repo, 'a.txt'), 'edited-at-checkpoint\n', 'uncommitted edit re-applied');
  assert.equal(read(repo, 'note.md'), 'keep me\n', 'checkpoint untracked restored');
  assert.equal(fs.existsSync(path.join(repo, 'extra.txt')), false, 'post-checkpoint untracked removed');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkpointStore: record / read / list / rollback / prune per turn', () => {
  const repo = initRepo();
  write(repo, 'f.txt', 'v0\n');
  commitAll(repo, 'init');
  const ws = repo;
  const sk = 'session:ckpt';

  const c0 = recordTurnCheckpoint(ws, sk, repo, 0);
  assert.ok(c0 && c0.turnIndex === 0);
  write(repo, 'f.txt', 'v1\n');
  commitAll(repo, 'turn0 work'); // HEAD advances

  const c1 = recordTurnCheckpoint(ws, sk, repo, 1);
  assert.ok(c1);
  write(repo, 'f.txt', 'v2\n'); // uncommitted

  assert.deepEqual(listTurnCheckpoints(ws, sk), [0, 1]);
  assert.ok(readTurnCheckpoint(ws, sk, 0));

  // roll back to turn 0 → both the later commit AND the uncommitted edit are undone
  const r = rollbackToTurnCheckpoint(ws, sk, repo, 0);
  assert.equal(r.ok, true, r.error);
  assert.equal(read(repo, 'f.txt'), 'v0\n');

  // prune after turn 0 drops turn 1's checkpoint
  pruneTurnCheckpointsAfter(ws, sk, 0);
  assert.deepEqual(listTurnCheckpoints(ws, sk), [0]);

  // rollback with no checkpoint for that turn → clear, fail-closed error
  const miss = rollbackToTurnCheckpoint(ws, sk, repo, 99);
  assert.equal(miss.ok, false);
  assert.match(miss.error ?? '', /no git checkpoint/);
  fs.rmSync(repo, { recursive: true, force: true });
});
