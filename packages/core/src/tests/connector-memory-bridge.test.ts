import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorDocument } from '@kinqs/brainrouter-types';
import {
  connectorDocumentToMemoryRecord,
  connectorMemoryId,
  exportConnectorDocumentsForMemory,
} from '../connectors/memoryBridge.js';
import { upsertConnectorDocuments } from '../connectors/documentStore.js';
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
    text: 'Fix the connector retry loop',
    metadata: { number: 1, labels: ['bug'] },
    ...overrides,
  };
}

test('connectorDocumentToMemoryRecord builds stable recall-eligible cognitive records', () => {
  const record = connectorDocumentToMemoryRecord({
    ...doc({ kind: 'file', id: 'github:org/repo:file:README.md', title: 'README.md', metadata: { path: 'README.md' } }),
    firstSeenAt: '2026-01-02T00:00:00.000Z',
    lastSeenAt: '2026-01-03T00:00:00.000Z',
  }, {
    userId: 'u1',
    workspaceRoot: '/tmp/work',
    sessionKey: 'session:test',
    now: '2026-01-04T00:00:00.000Z',
  });

  assert.equal(record.id, connectorMemoryId('github:org/repo:file:README.md'));
  assert.equal(record.userId, 'u1');
  assert.equal(record.sessionKey, 'session:test');
  assert.equal(record.type, 'source_evidence');
  assert.equal(record.sourceKind, 'source_file');
  assert.deepEqual(record.repoPaths, ['org/repo']);
  assert.deepEqual(record.filePaths, ['README.md']);
  assert.equal(record.metadata.connectorDocumentId, 'github:org/repo:file:README.md');
  assert.match(record.content, /Connector file: README\.md/);
  assert.match(record.content, /Repository: org\/repo/);
});

test('exportConnectorDocumentsForMemory creates a memory_import envelope from stored connector documents', () => {
  withTempWorkspace((workspace) => {
    upsertConnectorDocuments(workspace, [
      doc({ id: 'github:org/repo:issue:1', connectorId: 'conn_1', title: 'Retry issue', text: 'Retry loop' }),
      doc({ id: 'github:org/repo:pull:2', connectorId: 'conn_1', kind: 'pull-request', title: 'Streaming PR', text: 'Fix streaming' }),
      doc({ id: 'github:org/other:file:README.md', connectorId: 'conn_2', kind: 'file', repository: 'org/other', title: 'README.md', text: 'Connector docs', metadata: { path: 'README.md' } }),
    ], { now: '2026-01-05T00:00:00.000Z' });

    const result = exportConnectorDocumentsForMemory(workspace, {
      connectorId: 'conn_1',
      userId: 'u1',
      sessionKey: 'session:test',
      now: '2026-01-06T00:00:00.000Z',
    });

    assert.equal(result.data.version, 1);
    assert.equal(result.recordCount, 2);
    assert.equal(result.evidenceCount, 2);
    assert.equal(result.operationCount, 1);
    assert.deepEqual([...result.data.memories.map((record) => record.id)].sort(), [
      connectorMemoryId('github:org/repo:pull:2'),
      connectorMemoryId('github:org/repo:issue:1'),
    ].sort());
    assert.equal(result.data.memories.find((record) => record.id === connectorMemoryId('github:org/repo:pull:2'))?.type, 'review_comment');
    assert.equal(result.data.operations?.[0].operation, 'connector_import');
    assert.deepEqual(result.data.operations?.[0].metadata.connectorIds, ['conn_1']);
  });
});
