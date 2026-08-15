import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMcpCatalogTool,
  searchMcpCatalog,
  toToolBrief,
  type McpCatalogTool,
} from '../mcp/discovery/discovery.js';

const CATALOG: McpCatalogTool[] = [
  { name: 'mcp_github_create_issue', __rawName: 'create_issue', __serverId: 'github', description: 'Open a new GitHub issue in a repository.' },
  { name: 'mcp_github_search_code', __rawName: 'search_code', __serverId: 'github', description: 'Search code across GitHub repositories.' },
  { name: 'mcp_slack_post_message', __rawName: 'post_message', __serverId: 'slack', description: 'Post a message to a Slack channel.' },
  { name: 'mcp_db_run_query', __rawName: 'run_query', __serverId: 'db', description: 'Run a read-only SQL query against the database.' },
];

test('resolveMcpCatalogTool prefers exact names and only accepts unique raw aliases', () => {
  assert.equal(
    resolveMcpCatalogTool(CATALOG, 'mcp_github_create_issue')?.name,
    'mcp_github_create_issue',
  );
  assert.equal(resolveMcpCatalogTool(CATALOG, 'create_issue')?.name, 'mcp_github_create_issue');
  const collision = [
    ...CATALOG,
    { name: 'mcp_other_create_issue', __rawName: 'create_issue' },
  ];
  assert.equal(resolveMcpCatalogTool(collision, 'create_issue'), undefined);
  assert.equal(
    resolveMcpCatalogTool(collision, 'mcp_other_create_issue')?.name,
    'mcp_other_create_issue',
  );
});

test('searchMcpCatalog: name match ranks above description-only match', () => {
  const res = searchMcpCatalog(CATALOG, 'issue', 5);
  assert.equal(res[0].name, 'mcp_github_create_issue');
  assert.equal(res[0].server, 'github');
});

test('searchMcpCatalog: multi-term all-match ranks first', () => {
  const res = searchMcpCatalog(CATALOG, 'search code', 5);
  assert.equal(res[0].name, 'mcp_github_search_code');
});

test('searchMcpCatalog: matches description terms too', () => {
  const res = searchMcpCatalog(CATALOG, 'sql', 5);
  assert.equal(res.length, 1);
  assert.equal(res[0].name, 'mcp_db_run_query');
});

test('searchMcpCatalog: no match → empty', () => {
  assert.deepEqual(searchMcpCatalog(CATALOG, 'kubernetes helm chart', 5), []);
});

test('searchMcpCatalog: empty query lists first maxResults in order', () => {
  const res = searchMcpCatalog(CATALOG, '   ', 2);
  assert.equal(res.length, 2);
  assert.equal(res[0].name, 'mcp_github_create_issue');
  assert.equal(res[1].name, 'mcp_github_search_code');
});

test('searchMcpCatalog: respects maxResults cap', () => {
  const res = searchMcpCatalog(CATALOG, 'a', 1); // 'a' appears in several descriptions
  assert.ok(res.length <= 1);
});

test('toToolBrief: clips long descriptions and carries the server', () => {
  const long = 'x'.repeat(500);
  const brief = toToolBrief({ name: 'mcp_x_y', __serverId: 'x', description: long });
  assert.equal(brief.server, 'x');
  assert.ok(brief.summary.length <= 200);
  assert.ok(brief.summary.endsWith('…'));
});

test('toToolBrief: omits server when absent, normalizes whitespace', () => {
  const brief = toToolBrief({ name: 'mcp_x_y', description: 'multi\n  line   desc' });
  assert.equal(brief.server, undefined);
  assert.equal(brief.summary, 'multi line desc');
});
