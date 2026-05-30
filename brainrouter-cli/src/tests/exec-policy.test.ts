import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExecutionPolicy } from '../runtime/execPolicy.js';

test('CLI-11 read mode: read-only allowed, everything mutating denied', () => {
  assert.equal(decideExecutionPolicy('read_only', 'read').decision, 'allow');
  assert.equal(decideExecutionPolicy('file_edit', 'read').decision, 'deny');
  assert.equal(decideExecutionPolicy('child_write', 'read').decision, 'deny');
  assert.equal(decideExecutionPolicy('shell', 'read').decision, 'deny');
});

test('CLI-11 write mode: file edits allowed, shell still denied', () => {
  assert.equal(decideExecutionPolicy('file_edit', 'write').decision, 'allow');
  assert.equal(decideExecutionPolicy('child_write', 'write').decision, 'allow');
  const shell = decideExecutionPolicy('shell', 'write');
  assert.equal(shell.decision, 'deny');
  assert.match(shell.reason, /requires "shell" mode/);
});

test('CLI-11 shell mode: everything allowed', () => {
  for (const a of ['read_only', 'file_edit', 'child_write', 'shell'] as const) {
    assert.equal(decideExecutionPolicy(a, 'shell').decision, 'allow', `${a} should be allowed in shell mode`);
  }
});

test('CLI-11 network + bg are allowed in every mode (not access-mode gated)', () => {
  for (const m of ['read', 'write', 'shell'] as const) {
    assert.equal(decideExecutionPolicy('network', m).decision, 'allow');
    assert.equal(decideExecutionPolicy('bg', m).decision, 'allow');
  }
});
