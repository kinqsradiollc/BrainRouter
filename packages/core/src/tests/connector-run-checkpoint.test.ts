import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  buildCheckpointRunner,
  defaultEnvTokenResolver,
  runConnectorCheckpointCore,
} from '../connectors/runtime/runCheckpoint.js';
import { createConnector } from '../connectors/store/connectorStore.js';
import type { GithubConnectorClient } from '../connectors/sources/githubConnector.js';
import type { McpConnectorClient } from '../connectors/sources/mcpConnector.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function connector(overrides?: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_test',
    source: 'github',
    name: 'Test',
    status: 'active',
    config: {},
    credential: { mode: 'none' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const fakeGithubClient: GithubConnectorClient = {
  async listRepositories() {
    return [];
  },
  async listIssues() {
    return [{ number: 1, title: 'Issue', body: 'body', state: 'open', updatedAt: '2026-01-02T00:00:00.000Z' }];
  },
  async listPullRequests() {
    return [];
  },
  async listFiles() {
    return [];
  },
};

// ── defaultEnvTokenResolver ──────────────────────────────────────────────────

test('defaultEnvTokenResolver returns {} for credential mode none', () => {
  assert.deepEqual(defaultEnvTokenResolver(connector({ credential: { mode: 'none' } }), 'X'), {});
});

test('defaultEnvTokenResolver reads the env var named by credential.ref (static)', () => {
  const ref = 'BR_TEST_CONNECTOR_TOKEN_' + Math.random().toString(36).slice(2);
  process.env[ref] = 'secret-token';
  try {
    const result = defaultEnvTokenResolver(connector({ credential: { mode: 'static', ref } }), 'Slack');
    assert.equal(result.token, 'secret-token');
    assert.equal(result.error, undefined);
  } finally {
    delete process.env[ref];
  }
});

test('defaultEnvTokenResolver errors when the static env var is missing', () => {
  const ref = 'BR_TEST_MISSING_' + Math.random().toString(36).slice(2);
  delete process.env[ref];
  const result = defaultEnvTokenResolver(connector({ credential: { mode: 'static', ref } }), 'Notion');
  assert.equal(result.token, undefined);
  assert.match(result.error ?? '', /not available/);
});

test('defaultEnvTokenResolver rejects non-static credential modes', () => {
  const result = defaultEnvTokenResolver(connector({ credential: { mode: 'oauth', ref: 'x' } }), 'GitHub');
  assert.match(result.error ?? '', /static environment-token/);
});

// ── buildCheckpointRunner: per-source dispatch ───────────────────────────────

test('buildCheckpointRunner routes github to the caller-supplied client', async () => {
  let receivedConnectorId = '';
  const run = buildCheckpointRunner({
    githubClient: (c) => {
      receivedConnectorId = c.id;
      return fakeGithubClient;
    },
  });
  const result = await run(connector({
    source: 'github',
    config: { owner: 'kinqsradiollc', repositories: ['BrainRouter'], includeIssues: true, includePullRequests: false, includeFiles: false },
  }));
  assert.equal(receivedConnectorId, 'conn_test');
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].source, 'github');
});

test('buildCheckpointRunner routes mcp to the caller-supplied MCP client', async () => {
  const seen: string[] = [];
  const mcpClient: McpConnectorClient = {
    async listResources() {
      seen.push('list');
      return [{ server: 'srv', uri: 'file:///a.txt', name: 'a' }];
    },
    async readResource(resource) {
      seen.push(`read:${resource.uri}`);
      return { contents: [{ uri: resource.uri, text: 'hello world' }] };
    },
  };
  const run = buildCheckpointRunner({ mcpClient: () => mcpClient });
  const result = await run(connector({ source: 'mcp', config: { serverId: 'srv' } }));
  assert.deepEqual(seen, ['list', 'read:file:///a.txt']);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].source, 'mcp');
});

test('buildCheckpointRunner invokes the envToken resolver with the source label for a token source', async () => {
  // Offline: a sentinel resolver records the label + short-circuits before any
  // network call, proving the runner routes token sources through envToken.
  const labels: string[] = [];
  const run = buildCheckpointRunner({
    envToken: (_c, label) => {
      labels.push(label);
      return { error: `sentinel:${label}` };
    },
  });
  await assert.rejects(
    run(connector({ source: 'slack', credential: { mode: 'static', ref: 'X' } })),
    /sentinel:Slack/,
  );
  assert.deepEqual(labels, ['Slack']);
});

test('buildCheckpointRunner defaults envToken to process.env when the caller omits it', async () => {
  const ref = 'BR_TEST_LINEAR_' + Math.random().toString(36).slice(2);
  delete process.env[ref];
  // No caller envToken → the default reads process.env[ref], which is unset, so
  // the runner throws the "not available in the environment" credential error
  // BEFORE any network call.
  const run = buildCheckpointRunner({});
  await assert.rejects(
    run(connector({ source: 'linear', credential: { mode: 'static', ref } })),
    /not available in the environment/,
  );
});

test('buildCheckpointRunner throws a clear credential error for a static token source with no token', async () => {
  const run = buildCheckpointRunner({ envToken: () => ({ error: 'Notion connector credential X is not available in the environment.' }) });
  await assert.rejects(
    run(connector({ source: 'notion', credential: { mode: 'static', ref: 'X' } })),
    /not available in the environment/,
  );
});

// ── buildCheckpointRunner: oauth / keychain guard ────────────────────────────

test('buildCheckpointRunner throws the desktop-only guidance for github with no client (oauth/keychain)', async () => {
  const run = buildCheckpointRunner({ githubClient: () => undefined });
  await assert.rejects(
    run(connector({ source: 'github', credential: { mode: 'oauth', ref: 'gh' }, config: { owner: 'x' } })),
    /run it from BrainRouter Desktop/,
  );
});

test('buildCheckpointRunner throws for github when no githubClient dep is provided at all', async () => {
  const run = buildCheckpointRunner({});
  await assert.rejects(
    run(connector({ source: 'github', config: { owner: 'x' } })),
    /run it from BrainRouter Desktop/,
  );
});

test('buildCheckpointRunner errors for the mcp source with no MCP client', async () => {
  const run = buildCheckpointRunner({});
  await assert.rejects(
    run(connector({ source: 'mcp', config: { serverId: 'srv' } })),
    /requires a connected MCP client/,
  );
});

test('buildCheckpointRunner throws for an unimplemented source', async () => {
  const run = buildCheckpointRunner({});
  await assert.rejects(
    run(connector({ source: 'asana' as never })),
    /not implemented for asana/,
  );
});

// ── runConnectorCheckpointCore: full orchestration ───────────────────────────

test('runConnectorCheckpointCore records a run, persists documents, and returns them', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const created = createConnector(workspace, {
      source: 'github',
      name: 'GH',
      config: { owner: 'kinqsradiollc', repositories: ['BrainRouter'], includeIssues: true, includePullRequests: false, includeFiles: false },
      credential: { mode: 'none' },
      flows: ['checkpoint'],
    });
    const result = await runConnectorCheckpointCore(workspace, created.id, {
      githubClient: () => fakeGithubClient,
    });
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].source, 'github');
    assert.equal(result.run.status, 'succeeded');
    assert.equal(result.run.documentsSeen, 1);
    assert.equal(result.run.documentsIndexed, 1);
  });
});

test('runConnectorCheckpointCore marks the run failed and returns the error when the checkpoint throws', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const created = createConnector(workspace, {
      source: 'github',
      name: 'GH',
      config: { owner: 'x' },
      credential: { mode: 'oauth', ref: 'gh' },
      flows: ['checkpoint'],
    });
    // No githubClient → runner throws the desktop-only guidance; core records a
    // failed run and surfaces the message (no exception escapes).
    const result = await runConnectorCheckpointCore(workspace, created.id, {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /run it from BrainRouter Desktop/);
    assert.equal(result.run.status, 'failed');
    assert.equal(result.documents.length, 0);
  });
});

test('runConnectorCheckpointCore throws when the connector id is unknown', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    await assert.rejects(runConnectorCheckpointCore(workspace, 'conn_missing', {}), /Connector not found/);
  });
});
