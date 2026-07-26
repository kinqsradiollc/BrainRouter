import test from 'node:test';
import assert from 'node:assert/strict';
import { toolVisual } from './toolVisual.js';

test('P23-3a labels a rejected child launch from its accepted-state trace', () => {
  assert.equal(
    toolVisual('delegate_agent', 'failed', 'not-started').verb,
    'Delegation not started',
  );
});

test('P23-3a uses delegated only after launch acceptance', () => {
  assert.equal(toolVisual('delegate_agent', 'succeeded', 'accepted').verb, 'Delegated');
  assert.notEqual(toolVisual('wait_agent', 'failed').verb, 'Delegation not started');
  assert.notEqual(toolVisual('route_task', 'failed').verb, 'Delegation not started');
});
