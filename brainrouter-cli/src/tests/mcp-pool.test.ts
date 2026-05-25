import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClientPool } from '../runtime/mcpPool.js';

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
) {
  const fakeWrapper: any = {
    isConnected: () => true,
    getIdentity: () => identity,
    getServerName: () => serverId,
    listTools: async () => ({ tools }),
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

test('McpClientPool: listTools prefixes every tool with mcp__<serverId>__', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }, { name: 'list_repos' }]);
  await refreshIndex(pool);
  const { tools } = await pool.listTools();
  const names = tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, [
    'mcp__brainrouter__memory_recall',
    'mcp__github__create_issue',
    'mcp__github__list_repos',
  ]);
});

test('McpClientPool: callTool with prefixed form routes to the right server', async () => {
  const pool = new McpClientPool();
  seedFakeServer(pool, 'brainrouter', 'brainrouter', [{ name: 'memory_recall' }]);
  seedFakeServer(pool, 'github', 'third-party', [{ name: 'create_issue' }]);
  await refreshIndex(pool);
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
  assert.match(text, /mcp__first__search|mcp__second__search/);
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
  const res = await pool.callTool('mcp__github__list_open_pull_requests', {});
  assert.equal(res.content?.[0]?.text, 'github::list_open_pull_requests');
});
