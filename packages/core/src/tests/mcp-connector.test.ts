import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { runMcpConnectorCheckpoint, type McpConnectorClient } from '../connectors/sources/mcpConnector.js';

function connector(patch: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    id: 'conn_mcp',
    source: 'mcp',
    name: 'MCP resources',
    status: 'active',
    credential: { mode: 'none' },
    flows: ['checkpoint', 'slim'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
    config: { ...(patch.config ?? {}) },
  };
}

test('runMcpConnectorCheckpoint maps listed resources to documents', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: McpConnectorClient = {
    async listResources(opts) {
      calls.push(opts);
      return [{ server: 'docs', uri: 'resource://a', name: 'Guide', description: 'Docs guide', mimeType: 'text/markdown' }];
    },
    async readResource(resource) {
      assert.equal(resource.uri, 'resource://a');
      return { contents: [{ uri: resource.uri, mimeType: 'text/markdown', text: '# Guide' }] };
    },
  };
  const result = await runMcpConnectorCheckpoint(connector({ config: { serverId: 'docs' } }), client, { now: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(calls, [{ serverId: 'docs', resourceUris: [], limit: 100 }]);
  assert.equal(result.documents[0].id, 'mcp:conn_mcp:docs:resource://a');
  assert.equal(result.documents[0].repository, 'docs');
  assert.match(result.documents[0].text, /# Guide/);
  assert.equal(result.checkpoint.documentCount, 1);
});

test('runMcpConnectorCheckpoint records per-resource failures', async () => {
  const client: McpConnectorClient = {
    async listResources() {
      return [{ server: 'docs', uri: 'resource://missing' }];
    },
    async readResource() {
      throw new Error('not found');
    },
  };
  const result = await runMcpConnectorCheckpoint(connector(), client);
  assert.deepEqual(result.failures, ['docs:resource://missing: not found']);
  assert.equal(result.checkpoint.failureCount, 1);
});

test('runMcpConnectorCheckpoint validates connector source', async () => {
  await assert.rejects(
    () => runMcpConnectorCheckpoint(connector({ source: 'github' }), {} as McpConnectorClient),
    /not mcp/,
  );
});
