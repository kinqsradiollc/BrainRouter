import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExecutionPolicy, actionKindForTool, resolveToolPolicy } from '../runtime/execPolicy.js';

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

test('POLICY-1 actionKindForTool maps every mutating built-in (else read-only)', () => {
  assert.equal(actionKindForTool('run_command'), 'shell');
  for (const t of ['write_file', 'edit_file', 'apply_patch']) assert.equal(actionKindForTool(t), 'file_edit');
  for (const t of ['spawn_agent', 'spawn_agents', 'spawn_worker_thread']) assert.equal(actionKindForTool(t), 'child_write');
  assert.equal(actionKindForTool('fetch_url'), 'network');
  // Unknown / read tools default to read-only (safe — never wrongly mutating).
  assert.equal(actionKindForTool('read_file'), 'read_only');
  assert.equal(actionKindForTool('grep_search'), 'read_only');
});

test('POLICY-1 resolveToolPolicy unifies name → action → decision + mutating flag', () => {
  // file edits: denied in read, allowed once writing.
  assert.equal(resolveToolPolicy('write_file', 'read').decision, 'deny');
  const w = resolveToolPolicy('write_file', 'write');
  assert.equal(w.decision, 'allow');
  assert.equal(w.action, 'file_edit');
  assert.equal(w.mutating, true);

  // shell: only in shell mode; the reason explains the gate.
  const shellInWrite = resolveToolPolicy('run_command', 'write');
  assert.equal(shellInWrite.decision, 'deny');
  assert.match(shellInWrite.reason, /requires "shell" mode/);
  assert.equal(resolveToolPolicy('run_command', 'shell').decision, 'allow');

  // child spawns are child_write (mutating); denied in read.
  assert.equal(resolveToolPolicy('spawn_agents', 'read').decision, 'deny');
  assert.equal(resolveToolPolicy('spawn_agents', 'write').mutating, true);

  // read-only tools are allowed everywhere and NOT flagged mutating (no audit).
  for (const m of ['read', 'write', 'shell'] as const) {
    const r = resolveToolPolicy('read_file', m);
    assert.equal(r.decision, 'allow');
    assert.equal(r.mutating, false);
  }
});
