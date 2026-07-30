import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPairKey } from '../runtime/observability/toolPairing.js';

test('POLISH-1 toolPairKey: prefers the call id so same-name parallel calls do not collide', () => {
  // two parallel read_file calls get DISTINCT keys via their ids
  assert.equal(toolPairKey('read_file', 'call_a'), 'call_a');
  assert.equal(toolPairKey('read_file', 'call_b'), 'call_b');
  assert.notEqual(toolPairKey('read_file', 'call_a'), toolPairKey('read_file', 'call_b'));
});

test('POLISH-1 toolPairKey: falls back to the tool name when no id is provided', () => {
  assert.equal(toolPairKey('read_file'), 'read_file');
  assert.equal(toolPairKey('read_file', undefined), 'read_file');
  assert.equal(toolPairKey('read_file', null), 'read_file');
  assert.equal(toolPairKey('read_file', ''), 'read_file');
});
