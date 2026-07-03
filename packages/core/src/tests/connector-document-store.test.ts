import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorDocument } from '@kinqs/brainrouter-types';
import {
  countConnectorDocuments,
  deleteConnectorDocuments,
  getConnectorDocument,
  listConnectorDocuments,
  searchConnectorDocuments,
  upsertConnectorDocuments,
} from '../connectors/store/documentStore.js';
import { withTempWorkspace } from './_helpers.js';

function doc(overrides: Partial<ConnectorDocument>): ConnectorDocument {
  return {
    id: 'github:org/repo:issue:1',
    connectorId: 'conn_1',
    source: 'github',
    kind: 'issue',
    repository: 'org/repo',
    title: 'Issue one',
    url: 'https://github.test/org/repo/issues/1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    text: 'Fix the retry loop',
    metadata: { number: 1, labels: ['bug'] },
    ...overrides,
  };
}

test('connector document store upserts, preserves firstSeenAt, and updates lastSeenAt', () => {
  withTempWorkspace((workspace) => {
    const first = upsertConnectorDocuments(workspace, [doc({})], { now: '2026-01-02T00:00:00.000Z' });
    assert.equal(first.length, 1);
    assert.equal(first[0].firstSeenAt, '2026-01-02T00:00:00.000Z');
    assert.equal(first[0].lastSeenAt, '2026-01-02T00:00:00.000Z');

    const second = upsertConnectorDocuments(workspace, [doc({ title: 'Updated issue', text: 'New text' })], { now: '2026-01-03T00:00:00.000Z' });
    assert.equal(second[0].firstSeenAt, '2026-01-02T00:00:00.000Z');
    assert.equal(second[0].lastSeenAt, '2026-01-03T00:00:00.000Z');
    assert.equal(getConnectorDocument(workspace, 'github:org/repo:issue:1')?.title, 'Updated issue');
  });
});

test('connector document store lists, counts, searches, and deletes by connector', () => {
  withTempWorkspace((workspace) => {
    upsertConnectorDocuments(workspace, [
      doc({ id: 'github:org/repo:issue:1', connectorId: 'conn_1', title: 'Retry issue', text: 'Retry loop' }),
      doc({ id: 'github:org/repo:pull:2', connectorId: 'conn_1', kind: 'pull-request', title: 'Streaming PR', text: 'Fix streaming', updatedAt: '2026-01-04T00:00:00.000Z' }),
      doc({ id: 'github:org/other:file:README.md', connectorId: 'conn_2', kind: 'file', repository: 'org/other', title: 'README.md', text: 'Connector docs' }),
    ], { now: '2026-01-05T00:00:00.000Z' });

    assert.equal(countConnectorDocuments(workspace), 3);
    assert.equal(countConnectorDocuments(workspace, { connectorId: 'conn_1' }), 2);
    assert.deepEqual(listConnectorDocuments(workspace, { connectorId: 'conn_1' }).map((row) => row.id), [
      'github:org/repo:pull:2',
      'github:org/repo:issue:1',
    ]);
    assert.deepEqual(searchConnectorDocuments(workspace, { query: 'streaming' }).map((row) => row.id), ['github:org/repo:pull:2']);
    assert.deepEqual(searchConnectorDocuments(workspace, { query: 'connector', repository: 'org/other' }).map((row) => row.id), ['github:org/other:file:README.md']);

    assert.equal(deleteConnectorDocuments(workspace, 'conn_1'), 2);
    assert.equal(countConnectorDocuments(workspace), 1);
    assert.equal(getConnectorDocument(workspace, 'github:org/repo:issue:1'), undefined);
  });
});
