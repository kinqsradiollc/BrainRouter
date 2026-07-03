import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getStateFile } from '../storage/store.js';
import {
  connectorSupportsFlow,
  getConnectorCatalogEntry,
  listConnectorCatalog,
} from '../connectors/catalog.js';
import {
  createConnector,
  deleteConnector,
  finishConnectorRun,
  getConnector,
  listConnectorRuns,
  listConnectors,
  recordConnectorRun,
  setConnectorStatus,
  updateConnector,
} from '../connectors/stores/connectorStore.js';
import { withTempWorkspace } from './_helpers.js';

test('connector catalog exposes GitHub with Onyx-like flows', () => {
  const catalog = listConnectorCatalog();
  const github = getConnectorCatalogEntry('github');

  assert.equal(catalog.some((entry) => entry.source === 'github'), true);
  assert.ok(github);
  assert.deepEqual(github!.flows, ['load', 'checkpoint', 'slim', 'permission-sync']);
  assert.equal(connectorSupportsFlow('github', 'checkpoint'), true);
  assert.equal(connectorSupportsFlow('github', 'event'), false);

  github!.flows.push('event');
  assert.equal(getConnectorCatalogEntry('github')!.flows.includes('event'), false);
});

test('connectorStore creates, persists, updates, filters, and deletes instances', () => {
  withTempWorkspace((workspace) => {
    const connector = createConnector(workspace, {
      source: 'github',
      name: 'BrainRouter repos',
      config: {
        owner: 'kinqsradiollc',
        repositories: ['BrainRouter', 'brainrouter-desktop'],
        includeIssues: true,
        includePullRequests: true,
        includeFiles: false,
      },
      credential: { mode: 'dynamic', ref: 'gh', label: 'GitHub CLI' },
      flows: ['checkpoint', 'slim', 'permission-sync', 'checkpoint'],
    });

    assert.match(connector.id, /^conn_[0-9a-f]{8}$/);
    assert.equal(connector.status, 'active');
    assert.deepEqual(connector.flows, ['checkpoint', 'slim', 'permission-sync']);
    assert.equal(getConnector(workspace, connector.id)?.name, 'BrainRouter repos');

    const file = getStateFile(workspace, 'connectors.json');
    assert.equal(fs.existsSync(file), true);

    const renamed = updateConnector(workspace, connector.id, {
      name: 'GitHub knowledge',
      status: 'paused',
      config: { ...connector.config, includeFiles: true },
    });
    assert.ok(renamed);
    assert.equal(renamed!.name, 'GitHub knowledge');
    assert.equal(renamed!.status, 'paused');
    assert.equal(renamed!.config.includeFiles, true);
    assert.equal(renamed!.source, 'github');
    assert.equal(renamed!.workspaceRoot, workspace);

    assert.deepEqual(listConnectors(workspace, { source: 'github' }).map((entry) => entry.id), [connector.id]);
    assert.deepEqual(listConnectors(workspace, { status: 'active' }), []);
    assert.equal(setConnectorStatus(workspace, connector.id, 'active')?.status, 'active');
    assert.equal(deleteConnector(workspace, connector.id), true);
    assert.equal(getConnector(workspace, connector.id), undefined);
    assert.equal(deleteConnector(workspace, connector.id), false);
  });
});

test('connectorStore rejects unknown sources, empty names, and unsupported flows', () => {
  withTempWorkspace((workspace) => {
    assert.throws(
      () => createConnector(workspace, { source: 'github', name: '   ' }),
      /non-empty/,
    );
    assert.throws(
      () => createConnector(workspace, { source: 'github', name: 'GH', flows: ['event'] }),
      /does not support flow event/,
    );
    assert.throws(
      () => createConnector(workspace, { source: 'not-a-real-source' as any, name: 'Bogus' }),
      /Unsupported connector source/,
    );
  });
});

test('connectorStore isolates workspaces', () => {
  withTempWorkspace((workspaceA) => {
    withTempWorkspace((workspaceB) => {
      const a = createConnector(workspaceA, { source: 'github', name: 'A' });
      const b = createConnector(workspaceB, { source: 'github', name: 'B' });

      assert.equal(getConnector(workspaceA, b.id), undefined);
      assert.equal(getConnector(workspaceB, a.id), undefined);
      assert.deepEqual(listConnectors(workspaceA).map((entry) => entry.name), ['A']);
      assert.deepEqual(listConnectors(workspaceB).map((entry) => entry.name), ['B']);
    });
  });
});

test('connectorStore records runs and promotes checkpoint/error state', () => {
  withTempWorkspace((workspace) => {
    const connector = createConnector(workspace, { source: 'github', name: 'GH' });
    const success = recordConnectorRun(workspace, {
      connectorId: connector.id,
      flow: 'checkpoint',
      status: 'running',
      checkpointBefore: { cursor: 'old' },
    });

    assert.match(success.id, /^crun_[0-9a-f]{8}$/);
    assert.equal(success.completedAt, undefined);
    const completed = finishConnectorRun(workspace, connector.id, success.id, {
      status: 'succeeded',
      documentsSeen: 10,
      documentsIndexed: 9,
      failures: 1,
      checkpointAfter: { cursor: 'abc' },
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.ok(completed);
    assert.equal(completed!.completedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(completed!.checkpointAfter, { cursor: 'abc' });
    assert.deepEqual(getConnector(workspace, connector.id)?.checkpoint, { cursor: 'abc' });
    assert.equal(getConnector(workspace, connector.id)?.lastError, undefined);

    const failed = recordConnectorRun(workspace, {
      connectorId: connector.id,
      flow: 'slim',
      status: 'failed',
      error: 'rate limited',
    });
    assert.equal(failed.error, 'rate limited');
    assert.equal(getConnector(workspace, connector.id)?.status, 'error');
    assert.equal(getConnector(workspace, connector.id)?.lastError, 'rate limited');
    assert.deepEqual(listConnectorRuns(workspace, connector.id).map((run) => run.id), [failed.id, success.id]);
    assert.equal(finishConnectorRun(workspace, connector.id, 'crun_missing', { status: 'failed' }), undefined);

    assert.throws(
      () => recordConnectorRun(workspace, { connectorId: connector.id, flow: 'event', status: 'queued' }),
      /does not support flow event/,
    );
    assert.throws(
      () => recordConnectorRun(workspace, { connectorId: 'conn_missing', flow: 'checkpoint', status: 'queued' }),
      /Connector not found/,
    );

    const permissionRun = recordConnectorRun(workspace, {
      connectorId: connector.id,
      flow: 'permission-sync',
      status: 'succeeded',
      permissionsSeen: 3,
      permissionsIndexed: 3,
    });
    assert.equal(permissionRun.permissionsSeen, 3);
    assert.equal(permissionRun.permissionsIndexed, 3);
  });
});
