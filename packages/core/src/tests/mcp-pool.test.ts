import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClientPool, selectMcpServerIds, applyBrainUrlOverride, brainHealthUrl, probeBrainHealth, embeddedBrainId } from '../mcp/mcpPool.js';

// These tests exercise the Pool's public API in isolation — connection
// state, name routing, collision detection, status surfaces — without
// spinning up a real MCP transport. We stub the per-server wrapper
// state via a `seedFakeServer` helper that reaches into the Pool's
// internals so the tests stay tight on the dispatch logic.
//
// Real connect-path coverage lives in mcp.test.ts (integration);
// these tests are unit-level on the routing layer.

interface FakeTool { name: string; description?: string; }

function seedFakeServer(
  pool: McpClientPool,
  serverId: string,
  identity: 'brainrouter' | 'third-party' | 'unknown',
  tools: FakeTool[],
  callImpl?: (rawTool: string, args: any) => any,
  resources?: {
    list?: any[];
    templates?: any[];
    read?: Record<string, any>;
    nextCursor?: string;
  },
) {
  const fakeWrapper: any = {
    isConnected: () => true,
    getIdentity: () => identity,
    getServerName: () => serverId,
    listTools: async () => ({ tools }),
    listResources: async () => ({
      resources: resources?.list ?? [],
      ...(resources?.nextCursor ? { nextCursor: resources.nextCursor } : {}),
    }),
    listResourceTemplates: async () => ({
      resourceTemplates: resources?.templates ?? [],
      ...(resources?.nextCursor ? { nextCursor: resources.nextCursor } : {}),
    }),
    readResource: async ({ uri }: { uri: string }) =>
      resources?.read?.[uri] ?? { contents: [{ uri, text: `${serverId}::${uri}` }] },
    callTool: async (name: string, args: any) =>
      callImpl ? callImpl(name, args) : { isError: false, content: [{ type: 'text', text: `${serverId}::${name}` }] },
    close: async () => {},
  };
  // Bracket access bypasses `private` for test-only stubbing; the
  // accessor pattern is stable across the file.
  (pool as any)['clients'].set(serverId, fakeWrapper);
  (pool as any)['statuses'].set(serverId, { serverId, identity, status: 'connected', toolCount: tools.length });
}

async function refreshIndex(pool: McpClientPool): Promise<void> {
  await (pool as any)['refreshToolIndex']();
}

test('McpClientPool: empty pool reports isConnected false + undefined getServerName', () => {
  const pool = new McpClientPool();
  assert.equal(pool.isConnected(), false);
  assert.equal(pool.getServerName(), undefined);
  assert.equal(pool.getIdentity(), 'unknown');
  assert.deepEqual(pool.getStatuses(), []);
});

test('McpClientPool: single connected server — name + identity flow through', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }, { name: 'memory_search' }]);
  await refreshIndex(pool);
  assert.equal(pool.isConnected(), true);
  assert.equal(pool.getServerName(), 'brainrouter');
  assert.equal(pool.getIdentity(), 'brainrouter');
  const statuses = pool.getStatuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].toolCount, 2);
});

test('McpClientPool: refreshToolIndex updates status identity after tool-signature detection', async () => {
  const pool = new McpClientPool();
  const fakeWrapper: any = {
    isConnected: () => true,
    getIdentity: () => 'brainrouter',
    getServerName: () => 'ambiguousBrain',
    listTools: async () => ({ tools: [{ name: 'memory_recall' }, { name: 'list_skills' }] }),
    callTool: async () => ({ isError: false, content: [] }),
    close: async () => {},
  };
  (pool as any)['clients'].set('ambiguousBrain', fakeWrapper);
  (pool as any)['statuses'].set('ambiguousBrain', {
    serverId: 'ambiguousBrain',
    identity: 'unknown',
    status: 'connected',
  });

  await refreshIndex(pool);

  assert.equal(pool.getStatus('ambiguousBrain')?.identity, 'brainrouter');
  assert.equal(pool.getStatus('ambiguousBrain')?.toolCount, 2);
});

test('McpClientPool: listTools prefixes every tool with mcp_<serverId>_', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }, { name: 'list_repos' }]);
  await refreshIndex(pool);
  const { tools } = await pool.listTools();
  const names = tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [
    'mcp_brainrouter_memory_recall',
    'mcp_github_create_issue',
    'mcp_github_list_repos',
  ]);
});

test('McpClientPool: listResources aggregates connected servers and tags each resource with server id', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [], undefined, {
    list: [{ uri: 'memory://recent', name: 'Recent memory' }],
  });
  seedFakeServer(pool, 'github', 'third-party', [], undefined, {
    list: [{ uri: 'repo://issues', name: 'Issues' }],
  });

  const res = await pool.listResources();

  assert.deepEqual(res.resources, [
    { server: 'brainrouter', uri: 'memory://recent', name: 'Recent memory' },
    { server: 'github', uri: 'repo://issues', name: 'Issues' },
  ]);
});

test('McpClientPool: listResourceTemplates supports server selector and returns server-tagged templates', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [], undefined, {
    templates: [{ uriTemplate: 'memory://{id}', name: 'Memory by id' }],
  });
  seedFakeServer(pool, 'github', 'third-party', [], undefined, {
    templates: [{ uriTemplate: 'repo://{owner}/{repo}', name: 'Repository' }],
    nextCursor: 'next-gh',
  });

  const res = await pool.listResourceTemplates({ server: 'github' });

  assert.deepEqual(res, {
    resourceTemplates: [{ server: 'github', uriTemplate: 'repo://{owner}/{repo}', name: 'Repository' }],
    nextCursor: 'next-gh',
  });
});

test('McpClientPool: readResource routes to the selected server and includes server in result', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'github', 'third-party', [], undefined, {
    read: {
      'repo://issues': { contents: [{ uri: 'repo://issues', text: 'open issues' }] },
    },
  });

  const res = await pool.readResource({ server: 'github', uri: 'repo://issues' });

  assert.deepEqual(res, {
    server: 'github',
    contents: [{ uri: 'repo://issues', text: 'open issues' }],
  });
});

test('McpClientPool: callTool with prefixed form routes to the right server', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }]);
  await refreshIndex(pool);
  const res = await pool.callTool('mcp_github_create_issue', { title: 'bug' });
  assert.equal(res.content?.[0]?.text, 'github::create_issue');
});

test('McpClientPool: callTool back-compat — legacy double-underscore form is normalised and still routed (0.3.8-R5)', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }]);
  await refreshIndex(pool);
  // Even though the canonical surface is single-underscore, callers that
  // hardcoded the legacy `mcp__<server>__<tool>` form must still route
  // correctly through the normalisation hop.
  const res = await pool.callTool('mcp__github__create_issue', { title: 'bug' });
  assert.equal(res.content?.[0]?.text, 'github::create_issue');
});

test('McpClientPool: callTool accepts raw name when unique (back-compat)', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }]);
  await refreshIndex(pool);
  const res = await pool.callTool('memory_recall', { query: 'X' });
  assert.equal(res.content?.[0]?.text, 'brainrouter::memory_recall');
});

test('McpClientPool: raw BrainRouter-owned tool calls prefer the active BrainRouter server on collision', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'list_skills' }]);
  seedFakeServer(pool, 'third_party', 'third-party', [{ name: 'list_skills' }]);
  await refreshIndex(pool);

  const res = await pool.callTool('list_skills', { scope: 'all' });

  assert.equal(res.content?.[0]?.text, 'brainrouter::list_skills');
});

test('McpClientPool: callTool reports ambiguous-name collision with hint to prefix', async () => {
  const pool = new McpClientPool();
  // Two servers expose the same unprefixed `search` tool name.
  seedFakeServer(pool, 'first',  'third-party', [{ name: 'search' }]);
  seedFakeServer(pool, 'second', 'third-party', [{ name: 'search' }]);
  await refreshIndex(pool);
  const res = await pool.callTool('search', { q: 'foo' });
  assert.equal(res.isError, true);
  const text = res.content?.[0]?.text ?? '';
  assert.match(text, /Ambiguous tool name "search"/);
  assert.match(text, /mcp_first_search|mcp_second_search/);
});

test('McpClientPool: callTool reports unknown-tool with actionable message', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  await refreshIndex(pool);
  const res = await pool.callTool('totally_not_a_tool', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /not found on any connected MCP server/);
});

test('McpClientPool: identity precedence — brainrouter wins over third-party', () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'github', 'third-party', []);
  seedFakeServer(pool, 'brainrouter', 'brainrouter', []);
  assert.equal(pool.getIdentity(), 'brainrouter');
});

test('McpClientPool: getServerName summarises multi-server pools', () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'a', 'brainrouter', []);
  seedFakeServer(pool, 'b', 'third-party', []);
  seedFakeServer(pool, 'c', 'third-party', []);
  const name = pool.getServerName();
  assert.match(name ?? '', /3 servers/);
  assert.match(name ?? '', /a, b, c/);
});

test('McpClientPool: getBrainrouterClient returns the brainrouter wrapper when present', () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'github', 'third-party', []);
  assert.equal(pool.getBrainrouterClient(), undefined);
  seedFakeServer(pool, 'brain', 'brainrouter', []);
  const w = pool.getBrainrouterClient();
  assert.ok(w);
  assert.equal(w!.getIdentity(), 'brainrouter');
});

test('McpClientPool: resolveToolCall handles tool names containing underscores', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'list_open_pull_requests' }]);
  await refreshIndex(pool);
  const res = await pool.callTool('mcp_github_list_open_pull_requests', {});
  assert.equal(res.content?.[0]?.text, 'github::list_open_pull_requests');
});

test('selectMcpServerIds: connects all third-party MCPs but only the active BrainRouter MCP', () => {
  const servers: any = {
    localBrain: { type: 'stdio', command: 'brainrouter-mcp' },
    github: { type: 'http', url: 'https://github.example/mcp', identity: 'third-party' },
    remoteBrain: { type: 'http', url: 'https://api.brainrouter.cloud/mcp' },
    linear: { type: 'http', url: 'https://linear.example/mcp', identity: 'third-party' },
  };

  assert.deepEqual(
    selectMcpServerIds(servers, 'remoteBrain').sort(),
    ['github', 'linear', 'remoteBrain'].sort(),
  );
});

test('selectMcpServerIds: --profile scopes to exactly that profile', () => {
  const servers: any = {
    localBrain: { type: 'stdio', command: 'brainrouter-mcp' },
    remoteBrain: { type: 'http', url: 'https://api.brainrouter.cloud/mcp' },
    github: { type: 'http', url: 'https://github.example/mcp', identity: 'third-party' },
  };

  assert.deepEqual(selectMcpServerIds(servers, 'remoteBrain', 'localBrain'), ['localBrain']);
});

test('selectMcpServerIds: falls back to the first BrainRouter profile when active is third-party', () => {
  const servers: any = {
    localBrain: { type: 'stdio', command: 'brainrouter-mcp' },
    remoteBrain: { type: 'http', url: 'https://api.brainrouter.cloud/mcp' },
    github: { type: 'http', url: 'https://github.example/mcp', identity: 'third-party' },
  };

  assert.deepEqual(
    selectMcpServerIds(servers, 'github').sort(),
    ['github', 'localBrain'].sort(),
  );
});

// --- REMOTE-BRAIN: applyBrainUrlOverride (Workstream A) -------------------

test('applyBrainUrlOverride: no-op when brainUrl is unset', () => {
  const servers: any = { localBrain: { type: 'stdio', command: 'brainrouter-mcp', apiKey: 'br_x' } };
  const out = applyBrainUrlOverride(servers, 'localBrain', null);
  assert.equal(out.servers, servers); // same ref — untouched
  assert.equal(out.activeServer, 'localBrain');
  assert.equal(applyBrainUrlOverride(servers, 'localBrain', undefined).servers, servers);
  assert.equal(applyBrainUrlOverride(servers, 'localBrain', '').servers, servers);
});

test('applyBrainUrlOverride: rewrites the active brain to http, preserves apiKey, drops stdio fields', () => {
  const servers: any = {
    localBrain: { type: 'stdio', command: 'brainrouter-mcp', args: ['--root', '/x'], env: { A: '1' }, apiKey: 'br_secret' },
    github: { type: 'http', url: 'https://github.example/mcp', identity: 'third-party' },
  };
  const out = applyBrainUrlOverride(servers, 'localBrain', 'https://brain.example/mcp');
  assert.equal(out.activeServer, 'localBrain');
  const brain = out.servers.localBrain;
  assert.equal(brain.type, 'http');
  assert.equal(brain.url, 'https://brain.example/mcp');
  assert.equal(brain.identity, 'brainrouter');
  assert.equal(brain.apiKey, 'br_secret'); // bearer key preserved
  assert.equal(brain.command, undefined); // stdio-only fields dropped
  assert.equal(brain.args, undefined);
  assert.equal(brain.env, undefined);
  // input not mutated; third-party server untouched
  assert.equal((servers.localBrain as any).type, 'stdio');
  assert.equal(out.servers.github, servers.github);
});

test('applyBrainUrlOverride: targets the active brain among several profiles', () => {
  const servers: any = {
    localBrain: { type: 'stdio', command: 'brainrouter-mcp' },
    cloudBrain: { type: 'http', url: 'https://old.example/mcp', identity: 'brainrouter', apiKey: 'br_c' },
  };
  const out = applyBrainUrlOverride(servers, 'cloudBrain', 'https://new.example/mcp');
  assert.equal(out.activeServer, 'cloudBrain');
  assert.equal(out.servers.cloudBrain.url, 'https://new.example/mcp');
  assert.equal(out.servers.cloudBrain.apiKey, 'br_c');
  assert.equal(out.servers.localBrain.type, 'stdio'); // the non-active brain is left alone
});

test('applyBrainUrlOverride: synthesizes a brain profile when none exists', () => {
  const out = applyBrainUrlOverride({}, '', 'https://brain.example/mcp', 'br_fallback');
  assert.equal(out.activeServer, 'brainrouter');
  const brain = out.servers.brainrouter;
  assert.equal(brain.type, 'http');
  assert.equal(brain.url, 'https://brain.example/mcp');
  assert.equal(brain.identity, 'brainrouter');
  assert.equal(brain.apiKey, 'br_fallback'); // caller-supplied key used when no profile to inherit from
});

// --- REMOTE-BRAIN Phase 2: health probe + embedded fallback ---------------

test('brainHealthUrl: swaps a trailing /mcp, else resolves /health at the origin', () => {
  assert.equal(brainHealthUrl('https://brain.example/mcp'), 'https://brain.example/health');
  assert.equal(brainHealthUrl('https://brain.example/mcp/'), 'https://brain.example/health');
  // path-mounted brain keeps the prefix
  assert.equal(brainHealthUrl('https://host/brainrouter/mcp'), 'https://host/brainrouter/health');
  // non-/mcp URL → origin /health
  assert.equal(brainHealthUrl('https://brain.example/'), 'https://brain.example/health');
});

test('probeBrainHealth: ok on 2xx, not-ok on non-2xx, swallows network errors', async () => {
  const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await probeBrainHealth('https://b/mcp', { fetchImpl: okFetch }), { ok: true, status: 200 });

  const downFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await probeBrainHealth('https://b/mcp', { fetchImpl: downFetch }), { ok: false, status: 503 });

  const throwFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const r = await probeBrainHealth('https://b/mcp', { fetchImpl: throwFetch });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
});

test('probeBrainHealth: sends Bearer apiKey when provided + hits the derived health url', async () => {
  let seenUrl = '', seenAuth: string | undefined;
  const spyFetch = (async (url: string, init: any) => {
    seenUrl = url; seenAuth = init?.headers?.Authorization; return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  await probeBrainHealth('https://b/mcp', { fetchImpl: spyFetch, apiKey: 'br_k' });
  assert.equal(seenUrl, 'https://b/health');
  assert.equal(seenAuth, 'Bearer br_k');
});

test('embeddedBrainId: first stdio brainrouter profile, ignoring http + third-party', () => {
  assert.equal(embeddedBrainId({
    cloud: { type: 'http', url: 'https://b/mcp', identity: 'brainrouter' } as any,
    local: { type: 'stdio', command: 'brainrouter-mcp' } as any,
  }), 'local');
  // only an http brain → no embedded fallback
  assert.equal(embeddedBrainId({ cloud: { type: 'http', url: 'https://b/mcp', identity: 'brainrouter' } as any }), null);
  // a stdio third-party MCP is not a brain
  assert.equal(embeddedBrainId({ tool: { type: 'stdio', command: 'x', identity: 'third-party' } as any }), null);
  assert.equal(embeddedBrainId({}), null);
});
