import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitCapabilityCache, deleteRefCas, proveBranchPreserved, safeDeleteBranch } from '../git/capabilities.js';
import type { CmdRunner } from '../git/prEmit.js';

const run: CmdRunner = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
};

function git(cwd: string, args: string[]): string {
  const result = run('git', args, cwd);
  assert.equal(result.ok, true, result.stderr);
  return result.stdout.trim();
}

function repo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'br-git-cap-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.test']);
  git(cwd, ['config', 'user.name', 'BrainRouter Test']);
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'base']);
  return cwd;
}

test('GitCapabilityCache records successes and removes a capability after a failed retry', () => {
  const cache = new GitCapabilityCache();
  const host = { id: 'ssh:build' };
  assert.equal(cache.has(host, 'cas-delete-ref'), false);
  assert.equal(cache.run(host, 'cas-delete-ref', () => ({ ok: true, value: 'yes' })).supported, true);
  assert.equal(cache.has(host, 'cas-delete-ref'), true);
  assert.equal(cache.run(host, 'cas-delete-ref', () => ({ ok: false, value: 'no' })).supported, false);
  assert.equal(cache.has(host, 'cas-delete-ref'), false);
});

test('GitCapabilityCache retries an unsupported host after the self-healing interval', () => {
  let now = 1_000;
  let probes = 0;
  const cache = new GitCapabilityCache({ retryMs: 100, now: () => now });
  const host = { id: 'wsl:ubuntu' };
  assert.equal(cache.supports(host, 'patch-equivalence', () => { probes += 1; return false; }), false);
  assert.equal(cache.supports(host, 'patch-equivalence', () => { probes += 1; return true; }), false);
  assert.equal(probes, 1, 'negative result is bounded by the retry interval');
  now += 101;
  assert.equal(cache.supports(host, 'patch-equivalence', () => { probes += 1; return true; }), true);
  assert.equal(cache.has(host, 'patch-equivalence'), true);
  assert.equal(probes, 2);
});

test('branch preservation proves ancestry and refuses unabsorbed commits', () => {
  const cwd = repo();
  try {
    git(cwd, ['branch', 'merged-candidate']);
    assert.equal(proveBranchPreserved(run, cwd, 'refs/heads/merged-candidate', ['main']).reason, 'ancestor');

    git(cwd, ['switch', '-c', 'unabsorbed']);
    fs.writeFileSync(path.join(cwd, 'unique.txt'), 'unique\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'unique']);
    git(cwd, ['switch', 'main']);
    const refused = safeDeleteBranch({ run, cwd, branch: 'unabsorbed', destinations: ['main'] });
    assert.equal(refused.ok, false);
    assert.equal(refused.proof.reason, 'unabsorbed-commits');
    assert.equal(run('git', ['show-ref', '--verify', 'refs/heads/unabsorbed'], cwd).ok, true, 'ref remains after refusal');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('branch preservation recognizes patch-equivalent commits after a squash/cherry-pick style integration', () => {
  const cwd = repo();
  try {
    git(cwd, ['switch', '-c', 'candidate']);
    fs.writeFileSync(path.join(cwd, 'candidate.txt'), 'candidate\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'candidate']);
    const candidate = git(cwd, ['rev-parse', 'HEAD']);
    git(cwd, ['switch', 'main']);
    git(cwd, ['cherry-pick', '--no-commit', candidate]);
    git(cwd, ['commit', '-m', 'integrated equivalent patch']);
    fs.writeFileSync(path.join(cwd, 'later.txt'), 'later\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'later']);
    const proof = proveBranchPreserved(run, cwd, 'refs/heads/candidate', ['main']);
    assert.equal(proof.safe, true);
    assert.equal(proof.reason, 'patch-equivalent');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('CAS ref deletion succeeds only for the expected immutable oid', () => {
  const cwd = repo();
  try {
    git(cwd, ['branch', 'delete-me']);
    const expected = git(cwd, ['rev-parse', 'refs/heads/delete-me']);
    assert.deepEqual(deleteRefCas(run, cwd, 'refs/heads/delete-me', expected), { ok: true });
    assert.equal(run('git', ['show-ref', '--verify', 'refs/heads/delete-me'], cwd).ok, false);

    git(cwd, ['branch', 'moved']);
    const stale = git(cwd, ['rev-parse', 'refs/heads/moved']);
    git(cwd, ['switch', 'moved']);
    fs.writeFileSync(path.join(cwd, 'moved.txt'), 'moved\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'move ref']);
    git(cwd, ['switch', 'main']);
    assert.equal(deleteRefCas(run, cwd, 'refs/heads/moved', stale).ok, false);
    assert.equal(run('git', ['show-ref', '--verify', 'refs/heads/moved'], cwd).ok, true, 'moved ref remains');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('branch preservation never authorizes deletion of a branch checked out in any worktree', () => {
  const cwd = repo();
  try {
    const proof = proveBranchPreserved(run, cwd, 'refs/heads/main', ['main']);
    assert.equal(proof.safe, false);
    assert.equal(proof.reason, 'checked-out');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
