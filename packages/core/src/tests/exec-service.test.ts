import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecService, ExecService } from '../exec/service.js';
import { decideExecutionPolicy } from '../exec/execPolicy.js';
import { evaluateCommandPolicy } from '../exec/commandPolicy.js';
import { isDangerousCommand, resolveRunCommandApproval } from '../exec/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../exec/destructiveCommandGuard.js';

test('ExecService is a pure facade — every method matches the exec module', () => {
  const svc = createExecService();
  assert.ok(svc instanceof ExecService);

  // policy
  assert.deepEqual(svc.policyFor('shell', 'read'), decideExecutionPolicy('shell', 'read'));
  assert.deepEqual(svc.policyFor('file_edit', 'write'), decideExecutionPolicy('file_edit', 'write'));

  // command classification
  assert.deepEqual(svc.classifyCommand('ls -la', ['ls']), evaluateCommandPolicy('ls -la', ['ls']));
  assert.deepEqual(svc.classifyCommand('rm -rf /'), evaluateCommandPolicy('rm -rf /', []));

  // dangerous
  assert.equal(svc.isDangerous('rm -rf /'), isDangerousCommand('rm -rf /'));
  assert.equal(svc.isDangerous('echo hi'), isDangerousCommand('echo hi'));

  // approval
  const prefs = { executionMode: 'fast' as const };
  const opts = { silent: false, goalActive: false };
  assert.equal(svc.resolveApproval(prefs, 'echo hi', opts), resolveRunCommandApproval(prefs, 'echo hi', opts));
  assert.equal(svc.resolveApproval(prefs, 'rm -rf /', { silent: true }), resolveRunCommandApproval(prefs, 'rm -rf /', { silent: true }));

  // destructive
  assert.deepEqual(svc.checkDestructive('git reset --hard'), evaluateDestructiveCommand('git reset --hard', {}));
});
