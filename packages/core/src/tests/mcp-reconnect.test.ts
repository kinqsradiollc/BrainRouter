import test from 'node:test';
import assert from 'node:assert/strict';
import { dueForReconnect } from '../mcp/mcpPool.js';

// WS9 — the auto-reconnect supervisor's pure "which servers to retry now" decision.

test('WS9 dueForReconnect: a failed/offline server past its backoff window is due', () => {
  const statuses = [
    { serverId: 'a', status: 'failed' },
    { serverId: 'b', status: 'connected' },
    { serverId: 'c', status: 'offline' },
  ];
  const due = dueForReconnect(statuses, new Map(), 1000);
  assert.deepEqual(due.sort(), ['a', 'c'], 'failed + offline are due; connected is not');
});

test('WS9 dueForReconnect: connected/connecting servers are never due', () => {
  const statuses = [
    { serverId: 'a', status: 'connected' },
    { serverId: 'b', status: 'connecting' },
  ];
  assert.deepEqual(dueForReconnect(statuses, new Map(), 9_999_999), []);
});

test('WS9 dueForReconnect: a failed server still inside its backoff window is NOT due', () => {
  const statuses = [{ serverId: 'a', status: 'failed' }];
  const nextAt = new Map([['a', 5000]]); // next retry scheduled at t=5000
  assert.deepEqual(dueForReconnect(statuses, nextAt, 3000), [], 'before the window → skipped');
  assert.deepEqual(dueForReconnect(statuses, nextAt, 5000), ['a'], 'at/after the window → due');
});
