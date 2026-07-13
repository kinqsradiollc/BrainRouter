import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowYaml, serializeFlowYaml } from './flowSchema.js';

const YAML = `
name: login
steps:
  - action: navigate
    target: login
  - action: type
    target: email-field
    text: me@x.com
  - action: tap
    target: login-submit
`;

test('parseFlowYaml reads an ordered step list', () => {
  const flow = parseFlowYaml(YAML);
  assert.equal(flow.name, 'login');
  assert.deepEqual(flow.steps.map((s) => s.action), ['navigate', 'type', 'tap']);
  const typeStep = flow.steps[1];
  assert.equal(typeStep.action === 'type' && typeStep.text, 'me@x.com');
});

test('parseFlowYaml rejects an invalid action and a type-step missing text', () => {
  assert.throws(() => parseFlowYaml('name: x\nsteps:\n  - action: frobnicate\n    target: y\n'));
  assert.throws(() => parseFlowYaml('name: x\nsteps:\n  - action: type\n    target: y\n'));
});

test('serialize → parse round-trips a flow', () => {
  const flow = { name: 'smoke', steps: [{ action: 'tap' as const, target: 'btn' }] };
  const yaml = serializeFlowYaml(flow);
  assert.deepEqual(parseFlowYaml(yaml), flow);
});
