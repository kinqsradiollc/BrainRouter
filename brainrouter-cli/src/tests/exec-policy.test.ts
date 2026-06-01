import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExecutionPolicy, actionKindForTool, actionKindForToolCall, resolveToolPolicy, isChildSpawnTool } from '../runtime/exec/execPolicy.js';

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

test('POLICY-2 orchestration / worker spawns gate as child_write; observers + MCP are read-only', () => {
  for (const t of ['spawn_agent', 'spawn_agents', 'spawn_worker_thread', 'task_agent', 'delegate_agent', 'delegate_reviewer']) {
    assert.equal(actionKindForTool(t), 'child_write', `${t} should be child_write`);
  }
  // Observation / planning orchestration tools + MCP reads are read-only (allowed everywhere).
  for (const t of ['wait_agent', 'wait_agents', 'list_agents', 'route_task', 'read_agent_transcript', 'wait_worker', 'memory_recall']) {
    assert.equal(actionKindForTool(t), 'read_only', `${t} should be read_only`);
  }
  // Child spawns/delegations: denied in read mode, allowed (and audited) once writing.
  assert.equal(resolveToolPolicy('spawn_agents', 'read').decision, 'deny');
  const del = resolveToolPolicy('delegate_reviewer', 'write');
  assert.equal(del.decision, 'allow');
  assert.equal(del.action, 'child_write');
  assert.equal(del.mutating, true);
});

test('REVIEW-FIX isChildSpawnTool recognises every spawn/delegate surface', () => {
  for (const t of ['spawn_agent', 'spawn_agents', 'spawn_worker_thread', 'task_agent', 'delegate_agent', 'delegate_reviewer']) {
    assert.equal(isChildSpawnTool(t), true, `${t} is a spawn tool`);
  }
  for (const t of ['read_file', 'write_file', 'run_command', 'wait_agent', 'memory_recall']) {
    assert.equal(isChildSpawnTool(t), false, `${t} is not a spawn tool`);
  }
});

test('REVIEW-FIX actionKindForToolCall maps a spawn from its requested child access', () => {
  // Single spawn: the `access` arg drives the kind.
  assert.equal(actionKindForToolCall('task_agent', { access: 'read' }), 'read_only');
  assert.equal(actionKindForToolCall('task_agent', { access: 'write' }), 'child_write');
  assert.equal(actionKindForToolCall('task_agent', { access: 'shell' }), 'shell');
  // Unspecified access → conservative child_write (unchanged default).
  assert.equal(actionKindForToolCall('task_agent', {}), 'child_write');
  assert.equal(actionKindForToolCall('task_agent'), 'child_write');
  assert.equal(actionKindForToolCall('delegate_agent', { access: 'read' }), 'read_only');
  // Non-spawn tools fall through to the name-only mapping.
  assert.equal(actionKindForToolCall('write_file', { access: 'read' }), 'file_edit');
  assert.equal(actionKindForToolCall('read_file', {}), 'read_only');
});

test('REVIEW-FIX batch spawn_agents gates on its most-powerful entry', () => {
  const allRead = { agents: [{ access: 'read' }, { access: 'read' }] };
  assert.equal(actionKindForToolCall('spawn_agents', allRead), 'read_only');
  const oneWrite = { agents: [{ access: 'read' }, { access: 'write' }] };
  assert.equal(actionKindForToolCall('spawn_agents', oneWrite), 'child_write');
  const oneShell = { agents: [{ access: 'read' }, { access: 'shell' }] };
  assert.equal(actionKindForToolCall('spawn_agents', oneShell), 'shell');
  // An unspecified entry is conservative (child_write).
  assert.equal(actionKindForToolCall('spawn_agents', { agents: [{ access: 'read' }, {}] }), 'child_write');
  // No/empty agents list → conservative child_write (unchanged).
  assert.equal(actionKindForToolCall('spawn_agents', { agents: [] }), 'child_write');
  assert.equal(actionKindForToolCall('spawn_agents', {}), 'child_write');
});

test('REVIEW-FIX a read-mode parent may fan out an access:read reviewer (the live bug)', () => {
  // The bug: a read parent could not spawn even a read-only reviewer.
  const readReviewer = resolveToolPolicy('task_agent', 'read', { access: 'read' });
  assert.equal(readReviewer.decision, 'allow', 'read parent → read child is a read-only fan-out');
  assert.equal(readReviewer.action, 'read_only');
  assert.equal(readReviewer.mutating, false);

  // A read parent still cannot escalate: spawning a write/shell child is denied.
  assert.equal(resolveToolPolicy('task_agent', 'read', { access: 'write' }).decision, 'deny');
  assert.equal(resolveToolPolicy('task_agent', 'read', { access: 'shell' }).decision, 'deny');

  // In write mode a write child is allowed (and audited); a shell child still isn't.
  const writeChild = resolveToolPolicy('task_agent', 'write', { access: 'write' });
  assert.equal(writeChild.decision, 'allow');
  assert.equal(writeChild.mutating, true);
  assert.equal(resolveToolPolicy('task_agent', 'write', { access: 'shell' }).decision, 'deny');

  // A batch of read-only reviewers is likewise permitted in read mode.
  assert.equal(resolveToolPolicy('spawn_agents', 'read', { agents: [{ access: 'read' }] }).decision, 'allow');
});
