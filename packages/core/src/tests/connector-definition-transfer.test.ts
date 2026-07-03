import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnector,
  listConnectors,
  recordConnectorRun,
} from '../connectors/stores/connectorStore.js';
import {
  exportConnectorDefinitions,
  importConnectorDefinitions,
} from '../connectors/definitionTransfer.js';
import { withTempWorkspace } from './_helpers.js';

test('exportConnectorDefinitions emits portable definitions without runtime state or secrets', () => {
  withTempWorkspace((workspace) => {
    const connector = createConnector(workspace, {
      source: 'github',
      name: 'GitHub repos',
      description: 'Repo connector',
      config: { owner: 'org', repositories: ['repo'], includeIssues: true },
      credential: { mode: 'static', ref: 'BR_GITHUB_TOKEN', label: 'GitHub token', hasSecret: true },
      flows: ['checkpoint', 'slim', 'permission-sync'],
    });
    recordConnectorRun(workspace, {
      connectorId: connector.id,
      flow: 'checkpoint',
      status: 'succeeded',
      checkpointAfter: { highWatermark: '2026-01-01T00:00:00.000Z' },
    });

    const bundle = exportConnectorDefinitions(workspace, { now: '2026-01-02T00:00:00.000Z' });
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.exportedAt, '2026-01-02T00:00:00.000Z');
    assert.equal(bundle.connectors.length, 1);
    assert.deepEqual(bundle.connectors[0], {
      source: 'github',
      name: 'GitHub repos',
      description: 'Repo connector',
      config: { owner: 'org', repositories: ['repo'], includeIssues: true },
      credential: { mode: 'static', ref: 'BR_GITHUB_TOKEN', label: 'GitHub token', hasSecret: true },
      flows: ['checkpoint', 'slim', 'permission-sync'],
    });
    assert.equal(JSON.stringify(bundle).includes(connector.id), false);
    assert.equal(JSON.stringify(bundle).includes('highWatermark'), false);
  });
});

test('importConnectorDefinitions creates fresh connector records from bundle json', () => {
  withTempWorkspace((source) => {
    const original = createConnector(source, {
      source: 'github',
      name: 'GH',
      config: { owner: 'org', repositories: ['repo'] },
      credential: { mode: 'dynamic', ref: 'gh', label: 'GitHub CLI' },
      flows: ['checkpoint'],
    });
    const json = JSON.stringify(exportConnectorDefinitions(source));

    withTempWorkspace((target) => {
      const imported = importConnectorDefinitions(target, json);
      assert.equal(imported.length, 1);
      assert.notEqual(imported[0].id, original.id);
      assert.equal(imported[0].workspaceRoot, target);
      assert.equal(imported[0].name, 'GH');
      assert.deepEqual(imported[0].config, { owner: 'org', repositories: ['repo'] });
      assert.deepEqual(imported[0].credential, { mode: 'dynamic', ref: 'gh', label: 'GitHub CLI' });
      assert.deepEqual(imported[0].flows, ['checkpoint']);
      assert.deepEqual(listConnectors(target).map((connector) => connector.id), [imported[0].id]);
    });
  });
});

test('importConnectorDefinitions rejects unsupported bundle versions', () => {
  withTempWorkspace((workspace) => {
    assert.throws(
      () => importConnectorDefinitions(workspace, { schemaVersion: 99, exportedAt: '', connectors: [] } as never),
      /Unsupported connector definition bundle version/,
    );
  });
});
