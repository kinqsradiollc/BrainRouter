import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentDefinition } from '../orchestration/agentDefValidation.js';

const valid = {
  id: 'doc-writer',
  displayName: 'Doc Writer',
  whenToUse: 'When docs need updating',
  prompt: 'You write docs.',
  defaultAccess: 'write',
  toolScope: { local: ['read_file', 'write_file'], mcp: [] },
  disallowedTools: ['run_command'],
  maxIterations: 10,
  timeoutMs: 60000,
};

test('CLI-13 validateAgentDefinition: a well-formed def passes', () => {
  const r = validateAgentDefinition(valid);
  assert.equal(r.valid, true, r.errors.join('; '));
});

test('CLI-13 validateAgentDefinition: missing required fields + bad id', () => {
  const r = validateAgentDefinition({ id: 'Bad Id', toolScope: { local: [], mcp: [] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /displayName is required/.test(e)));
  assert.ok(r.errors.some((e) => /prompt is required/.test(e)));
  assert.ok(r.errors.some((e) => /kebab-case/.test(e)));
});

test('CLI-13 validateAgentDefinition: invalid access mode + tool-scope overlap', () => {
  const r = validateAgentDefinition({ ...valid, defaultAccess: 'admin', disallowedTools: ['write_file'] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /defaultAccess must be one of/.test(e)));
  assert.ok(r.errors.some((e) => /disallowedTools overlaps toolScope: write_file/.test(e)));
});

test('CLI-13 validateAgentDefinition: non-positive numeric bounds', () => {
  const r = validateAgentDefinition({ ...valid, maxIterations: 0, timeoutMs: -5 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /maxIterations must be a positive number/.test(e)));
  assert.ok(r.errors.some((e) => /timeoutMs must be a positive number/.test(e)));
});
