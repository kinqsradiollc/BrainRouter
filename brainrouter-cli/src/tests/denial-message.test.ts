import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDenial, formatDenialResult } from '../agent/denialMessage.js';

test('classifyDenial: user-declined paths', () => {
  assert.equal(classifyDenial('MCP tool "x" rejected by user.'), 'user-declined');
  assert.equal(classifyDenial('MCP tool "x" rejected by parent approval.'), 'user-declined');
});

test('classifyDenial: hook / policy / access-mode', () => {
  assert.equal(classifyDenial('Tool "edit_file" denied by hook pre-edit-guard.'), 'hook-blocked');
  assert.equal(classifyDenial('Tool "run_command" denied by execution policy: read mode.'), 'policy');
  assert.equal(classifyDenial('Command execution denied: dangerous command in a silent child.'), 'policy');
  assert.equal(classifyDenial('Tool "write_file" is not permitted in access mode "read".'), 'access-mode');
});

test('classifyDenial: ordinary failures are NOT denials', () => {
  assert.equal(classifyDenial('Tool execution failed: ECONNREFUSED'), null);
  assert.equal(classifyDenial('no such file or directory'), null);
  assert.equal(classifyDenial(''), null);
});

test('formatDenialResult: states who declined + the adjust-dont-retry contract', () => {
  const user = formatDenialResult('run_command', 'user-declined', 'rejected by user');
  assert.match(user, /user DECLINED/);
  assert.match(user, /Do NOT retry the same call/);
  assert.match(user, /different path/i);

  const policy = formatDenialResult('write_file', 'access-mode', 'not permitted in access mode "read"');
  assert.match(policy, /NOT ALLOWED in the current access mode/);
  assert.match(policy, /ask how they want to proceed/);
});
