import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorDocument } from '@kinqs/brainrouter-types';
import { retrieveConnectorSlimDocuments } from '../connectors/slimRetrieval.js';
import { upsertConnectorDocuments } from '../connectors/documentStore.js';
import { withTempWorkspace } from './_helpers.js';

function doc(input: Partial<ConnectorDocument> & Pick<ConnectorDocument, 'id' | 'connectorId' | 'kind' | 'title' | 'text'>): ConnectorDocument {
  return {
    source: 'github',
    repository: 'org/repo',
    metadata: {},
    ...input,
  };
}

test('retrieveConnectorSlimDocuments returns bounded snippets and ranked connector documents', () => {
  withTempWorkspace((workspace) => {
    upsertConnectorDocuments(workspace, [
      doc({ id: 'github:org/repo:issue:1', connectorId: 'conn_1', kind: 'issue', title: 'Fix onboarding crash', text: 'The onboarding flow crashes when connector sync is enabled.', updatedAt: '2026-01-02T00:00:00.000Z' }),
      doc({ id: 'github:org/repo:file:README.md', connectorId: 'conn_1', kind: 'file', title: 'README.md', text: 'Connector setup and static token instructions.', updatedAt: '2026-01-03T00:00:00.000Z' }),
      doc({ id: 'github:org/other:pull:2', connectorId: 'conn_2', kind: 'pull-request', repository: 'org/other', title: 'Connector sync patch', text: 'Adds slim retrieval for GitHub documents.', updatedAt: '2026-01-04T00:00:00.000Z' }),
    ]);

    const rows = retrieveConnectorSlimDocuments(workspace, { query: 'connector', limit: 10, maxSnippetChars: 96 });
    assert.deepEqual(rows.map((row) => row.id), [
      'github:org/other:pull:2',
      'github:org/repo:file:README.md',
      'github:org/repo:issue:1',
    ]);
    assert.equal(rows[0].kind, 'pull-request');
    assert.equal(rows[0].snippet.length <= 96, true);
    assert.equal(rows.every((row) => !('text' in row)), true);

    const filtered = retrieveConnectorSlimDocuments(workspace, { connectorId: 'conn_1', kind: 'file' });
    assert.deepEqual(filtered.map((row) => row.id), ['github:org/repo:file:README.md']);
  });
});
