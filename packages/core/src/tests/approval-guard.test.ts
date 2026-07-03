import test from 'node:test';
import assert from 'node:assert/strict';
import { isOverBroadCommandPrefix, sanitizeCommandAllowlist } from '../exec/guard/approvalGuard.js';

test('CODEX-APPROVAL-GUARD rejects shells, interpreters, escalators, and wrappers', () => {
  for (const p of ['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'ruby', 'perl', 'sudo', 'su', 'env', 'osascript', 'xargs', 'npx', 'eval', 'exec']) {
    assert.equal(isOverBroadCommandPrefix(p), true, `${p} must be rejected`);
  }
  // Even with args, a shell/escalator head stays over-broad.
  assert.equal(isOverBroadCommandPrefix('bash -c'), true);
  assert.equal(isOverBroadCommandPrefix('sudo apt-get install'), true);
});

test('CODEX-APPROVAL-GUARD rejects bare multiplexers but allows qualified subcommands', () => {
  // Bare multiplexer = over-broad (`git` ⊇ `git push --force`).
  for (const p of ['git', 'npm', 'docker', 'kubectl', 'cargo', 'make', 'aws']) {
    assert.equal(isOverBroadCommandPrefix(p), true, `bare ${p} must be rejected`);
  }
  // Qualified = specific enough to allow.
  for (const p of ['git status', 'npm test', 'npm run build', 'docker ps', 'cargo build', 'make lint']) {
    assert.equal(isOverBroadCommandPrefix(p), false, `${p} should be allowed`);
  }
});

test('CODEX-APPROVAL-GUARD rejects empty prefixes and shell-control operators', () => {
  assert.equal(isOverBroadCommandPrefix(''), true);
  assert.equal(isOverBroadCommandPrefix('   '), true);
  assert.equal(isOverBroadCommandPrefix('git status && rm -rf /'), true);
  assert.equal(isOverBroadCommandPrefix('ls | sh'), true);
  assert.equal(isOverBroadCommandPrefix('echo $(whoami)'), true);
});

test('CODEX-APPROVAL-GUARD allows specific read-only / scoped commands', () => {
  for (const p of ['ls', 'cat', 'grep -r foo', 'rg pattern', 'tsc --noEmit', 'jest', 'eslint .']) {
    assert.equal(isOverBroadCommandPrefix(p), false, `${p} should be allowed`);
  }
});

test('CODEX-APPROVAL-GUARD sanitizeCommandAllowlist splits allowed vs rejected, de-dupes', () => {
  const { allowed, rejected } = sanitizeCommandAllowlist([
    'git status', 'bash', 'npm test', 'git', '  npm test  ', 'sudo', 'ls',
  ]);
  assert.deepEqual(allowed, ['git status', 'npm test', 'ls']);
  assert.deepEqual(rejected, ['bash', 'git', 'sudo']);
});
