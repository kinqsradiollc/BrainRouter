import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorPermission } from '@kinqs/brainrouter-types';
import {
  countConnectorPermissions,
  deleteConnectorPermissions,
  listConnectorPermissions,
  upsertConnectorPermissions,
} from '../connectors/permissionStore.js';
import { createConnector, deleteConnector } from '../connectors/connectorStore.js';
import { withTempWorkspace } from './_helpers.js';

function permission(overrides: Partial<ConnectorPermission>): ConnectorPermission {
  return {
    id: 'github:org/repo:user:octo',
    connectorId: 'conn_1',
    source: 'github',
    principalId: 'octo',
    principalKind: 'user',
    role: 'admin',
    repositories: ['org/repo'],
    displayName: 'Octo Cat',
    metadata: { permissions: { admin: true } },
    ...overrides,
  };
}

test('connector permission store upserts, filters, and deletes permissions', () => {
  withTempWorkspace((workspace) => {
    const first = upsertConnectorPermissions(workspace, [permission({})], { now: '2026-01-01T00:00:00.000Z' });
    assert.equal(first.length, 1);
    assert.equal(first[0].firstSeenAt, '2026-01-01T00:00:00.000Z');

    const second = upsertConnectorPermissions(workspace, [permission({ role: 'write', repositories: ['org/repo', 'org/other'] })], { now: '2026-01-02T00:00:00.000Z' });
    assert.equal(second[0].firstSeenAt, '2026-01-01T00:00:00.000Z');
    assert.equal(second[0].lastSeenAt, '2026-01-02T00:00:00.000Z');
    assert.equal(second[0].role, 'write');

    upsertConnectorPermissions(workspace, [
      permission({ id: 'github:org/repo:user:dev', principalId: 'dev', role: 'read', displayName: undefined }),
      permission({ id: 'github:org/other:user:octo', connectorId: 'conn_2', principalId: 'octo', role: 'maintain', repositories: ['org/other'] }),
    ]);

    assert.equal(countConnectorPermissions(workspace), 3);
    assert.equal(countConnectorPermissions(workspace, { connectorId: 'conn_1' }), 2);
    assert.deepEqual(listConnectorPermissions(workspace, { repository: 'org/other' }).map((row) => row.id), [
      'github:org/other:user:octo',
      'github:org/repo:user:octo',
    ]);

    assert.equal(deleteConnectorPermissions(workspace, 'conn_1'), 2);
    assert.equal(countConnectorPermissions(workspace), 1);
  });
});

test('deleteConnector removes stored connector permissions', () => {
  withTempWorkspace((workspace) => {
    const connector = createConnector(workspace, { source: 'github', name: 'GH' });
    upsertConnectorPermissions(workspace, [permission({ connectorId: connector.id })]);

    assert.equal(countConnectorPermissions(workspace, { connectorId: connector.id }), 1);
    assert.equal(deleteConnector(workspace, connector.id), true);
    assert.equal(countConnectorPermissions(workspace, { connectorId: connector.id }), 0);
  });
});
