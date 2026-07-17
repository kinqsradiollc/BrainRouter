import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  sortConnectors, connectorStatusLabel, connectorCounts, hasError, lastActivityLabel, connectorSubtitle,
} from './connectorsView.js';

const conn = (over: Partial<ConnectorRecord>): ConnectorRecord => ({
  id: 'con_0001',
  source: 'github',
  name: 'Main repo',
  status: 'active',
  config: {},
  credential: { mode: 'none' },
  flows: ['load', 'poll'],
  workspaceRoot: '/ws',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

test('sortConnectors orders active→error→paused→deleting, then by name; non-mutating', () => {
  const list = [
    conn({ name: 'zeta', status: 'paused' }),
    conn({ name: 'beta', status: 'active' }),
    conn({ name: 'alpha', status: 'error' }),
    conn({ name: 'gamma', status: 'active' }),
  ];
  assert.deepEqual(sortConnectors(list).map((c) => c.name), ['beta', 'gamma', 'alpha', 'zeta']);
  assert.deepEqual(list.map((c) => c.name), ['zeta', 'beta', 'alpha', 'gamma'], 'input untouched');
});

test('connectorStatusLabel capitalizes the status', () => {
  assert.equal(connectorStatusLabel('active'), 'Active');
  assert.equal(connectorStatusLabel('error'), 'Error');
});

test('connectorCounts tallies every status + total', () => {
  const list = [conn({ status: 'active' }), conn({ status: 'active' }), conn({ status: 'error' }), conn({ status: 'paused' })];
  assert.deepEqual(connectorCounts(list), { active: 2, paused: 1, error: 1, deleting: 0, total: 4 });
});

test('hasError flags error status or a lastError string', () => {
  assert.equal(hasError(conn({ status: 'active' })), false);
  assert.equal(hasError(conn({ status: 'error' })), true);
  assert.equal(hasError(conn({ status: 'active', lastError: 'boom' })), true);
});

test('lastActivityLabel derives from error/success/run fields', () => {
  assert.equal(lastActivityLabel(conn({})), 'Never run');
  assert.equal(lastActivityLabel(conn({ lastRunAt: '2026-07-05T00:00:00.000Z' })), 'Ran');
  assert.equal(lastActivityLabel(conn({ lastSuccessAt: '2026-07-05T00:00:00.000Z' })), 'Synced');
  assert.equal(lastActivityLabel(conn({ lastError: 'boom', lastSuccessAt: '2026-07-05T00:00:00.000Z' })), 'Error');
});

test('connectorSubtitle shows source + flow count with pluralization', () => {
  assert.equal(connectorSubtitle(conn({ source: 'slack', flows: ['event'] })), 'slack · 1 flow');
  assert.equal(connectorSubtitle(conn({ source: 'github', flows: ['load', 'poll'] })), 'github · 2 flows');
});
