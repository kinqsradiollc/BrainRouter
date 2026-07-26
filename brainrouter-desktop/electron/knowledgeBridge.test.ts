import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceKnowledgeQueries,
  type WorkspaceKnowledgeBridgeOptions,
} from './knowledgeBridge.js';
import type { AccountFetch, BrainRouterAccountContext } from './accountIntegration.js';

interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function fixture(
  responses: Array<{ ok?: boolean; status?: number; body: unknown }>,
  overrides: Partial<WorkspaceKnowledgeBridgeOptions> = {},
) {
  const calls: FetchCall[] = [];
  const fetchImpl: AccountFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected fetch.');
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  const account: BrainRouterAccountContext = {
    baseUrl: 'https://brain.example.test',
    apiKey: 'secret-account-key',
    orgId: 'org_1',
  };
  const queries = buildWorkspaceKnowledgeQueries({
    getConfig: () => ({
      cli: { account: { url: 'https://brain.example.test' } },
      servers: { brain: { identity: 'brainrouter', apiKey: 'secret-account-key' } },
    }),
    getRemoteUrl: () => 'git@github.com:acme/app.git',
    fetchImpl,
    resolveAccount: async () => account,
    ...overrides,
  });
  return { calls, queries };
}

test('workspace query maps the git remote to one Project and returns a credential-free view', async () => {
  const { calls, queries } = fixture([
    { body: { projects: [{ projectId: 'proj_1', name: 'App', repoUrl: 'https://github.com/acme/app', secret: 'nope' }] } },
    { body: { bases: [{ baseId: 'kb_1', projectId: 'proj_1', name: 'Handbook', description: '', createdAt: 'a', updatedAt: 'b', secret: 'nope' }] } },
  ]);
  const result = await queries['knowledge-workspace']({}) as Record<string, unknown>;
  assert.deepEqual(result, {
    state: 'ready',
    project: { projectId: 'proj_1', name: 'App' },
    bases: [{ baseId: 'kb_1', name: 'Handbook', description: '', createdAt: 'a', updatedAt: 'b' }],
  });
  assert.match(calls[0].url, /projects\?repo=github\.com%2Facme%2Fapp$/);
  assert.equal(JSON.stringify(result).includes('secret-account-key'), false);
  assert.equal(JSON.stringify(result).includes('git@github.com'), false);
  assert.equal(JSON.stringify(result).includes('brain.example.test'), false);
});

test('workspace query strips credentials from HTTPS remotes before the backend request', async () => {
  const { calls, queries } = fixture([
    { body: { projects: [] } },
  ], {
    getRemoteUrl: () => 'https://oauth2:super-secret@github.com/acme/app.git',
  });
  await queries['knowledge-workspace']({});
  assert.match(calls[0].url, /repo=github\.com%2Facme%2Fapp$/);
  assert.equal(calls[0].url.includes('super-secret'), false);
  assert.equal(calls[0].url.includes('oauth2'), false);
});

test('workspace query handles zero and multiple repository matches explicitly', async () => {
  const missing = fixture([{ body: { projects: [] } }]);
  assert.deepEqual(await missing.queries['knowledge-workspace']({}), {
    state: 'unlinked',
    message: 'No accessible Project is linked to this workspace repository.',
  });

  const multiple = fixture([{
    body: {
      projects: [
        { projectId: 'proj_1', name: 'One', repoUrl: 'secret-remote-one' },
        { projectId: 'proj_2', name: 'Two', repoUrl: 'secret-remote-two' },
      ],
    },
  }]);
  assert.deepEqual(await multiple.queries['knowledge-workspace']({}), {
    state: 'ambiguous',
    message: 'More than one accessible Project is linked to this repository. Keep one link before continuing.',
    projects: [
      { projectId: 'proj_1', name: 'One' },
      { projectId: 'proj_2', name: 'Two' },
    ],
  });
});

test('workspace query handles signed-out and missing-remote states without network access', async () => {
  const signedOut = fixture([], {
    getConfig: () => ({}),
    resolveAccount: async () => { throw new Error('must not run'); },
  });
  assert.equal((await signedOut.queries['knowledge-workspace']({}) as { state: string }).state, 'signed-out');
  assert.equal(signedOut.calls.length, 0);

  const noRemote = fixture([], { getRemoteUrl: () => null });
  assert.equal((await noRemote.queries['knowledge-workspace']({}) as { state: string }).state, 'no-remote');
  assert.equal(noRemote.calls.length, 0);
});

test('document queries re-resolve Project scope and never trust a renderer project id', async () => {
  const { calls, queries } = fixture([
    { body: { projects: [{ projectId: 'proj_server', name: 'App' }] } },
    { body: { documents: [{ documentId: 'doc_1', title: 'Guide', sourceName: 'guide.md', sourceFormat: 'markdown', origin: 'source', status: 'ready', statusMessage: null, parseVersion: 1, createdAt: 'a', updatedAt: 'b', readyAt: 'c', contentText: 'must not cross' }] } },
  ]);
  const result = await queries['knowledge-documents']({ projectId: 'proj_attacker', baseId: 'kb_1' }) as Record<string, unknown>;
  assert.match(calls[1].url, /projects\/proj_server\/bases\/kb_1\/documents\?limit=200$/);
  assert.equal(calls[1].url.includes('proj_attacker'), false);
  assert.equal(JSON.stringify(result).includes('contentText'), false);
});

test('ingest rejects oversized content before making the mutation request', async () => {
  const { calls, queries } = fixture([
    { body: { projects: [{ projectId: 'proj_1', name: 'App' }] } },
  ]);
  const result = await queries['knowledge-ingest']({
    baseId: 'kb_1',
    title: 'Large',
    sourceName: 'large.html',
    sourceFormat: 'html',
    content: 'x'.repeat(1024 * 1024 + 1),
  }) as { state: string; message: string };
  assert.equal(result.state, 'error');
  assert.match(result.message, /too large/);
  assert.equal(calls.length, 1);
});

test('search sends account and organization headers only to the host-owned endpoint', async () => {
  const { calls, queries } = fixture([
    { body: { projects: [{ projectId: 'proj_1', name: 'App' }] } },
    { body: { search: { mode: 'lexical', hits: [{ content: 'Deploy with health probes.', score: 0.9, matchedBy: ['lexical'], citation: { baseId: 'kb_1', documentId: 'doc_1', chunkId: 'chunk_1', documentTitle: 'Guide', sourceName: 'guide.md', ordinal: 0, charStart: 0, charEnd: 26, locator: { path: '/private/server/path' } } }] } } },
  ]);
  const result = await queries['knowledge-search']({ query: 'health probes', baseId: 'kb_1' }) as Record<string, unknown>;
  assert.deepEqual(calls[1].init?.headers, {
    Authorization: 'Bearer secret-account-key',
    'X-BrainRouter-Org': 'org_1',
    'Content-Type': 'application/json',
  });
  assert.equal(JSON.stringify(result).includes('/private/server/path'), false);
  assert.equal(JSON.stringify(result).includes('secret-account-key'), false);
});

test('transport failures cannot echo backend URLs, local paths, or credentials to the renderer', async () => {
  const account: BrainRouterAccountContext = {
    baseUrl: 'https://brain.example.test',
    apiKey: 'secret-account-key',
    orgId: 'org_1',
  };
  const queries = buildWorkspaceKnowledgeQueries({
    getConfig: () => ({
      cli: { account: { url: account.baseUrl } },
      servers: { brain: { identity: 'brainrouter', apiKey: account.apiKey } },
    }),
    getRemoteUrl: () => 'git@github.com:acme/app.git',
    fetchImpl: async () => {
      throw new Error('connect https://secret@brain.example.test from /Users/private/workspace');
    },
    resolveAccount: async () => account,
  });
  assert.deepEqual(await queries['knowledge-workspace']({}), {
    state: 'error',
    message: 'Project knowledge is unavailable. Try again.',
  });
});

test('backend error bodies are not forwarded across the renderer boundary', async () => {
  const { queries } = fixture([
    {
      ok: false,
      status: 400,
      body: { error: 'failed at /private/tmp/store using Bearer secret-account-key' },
    },
  ]);
  assert.deepEqual(await queries['knowledge-workspace']({}), {
    state: 'error',
    message: 'Project knowledge request failed (HTTP 400).',
  });
});
