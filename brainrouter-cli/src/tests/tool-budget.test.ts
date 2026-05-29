import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAndCapTools, applyToolScope, toolRelevanceScore } from '../orchestration/toolBudget.js';

const T = (name: string, description = '') => ({ name, description });

test('rankAndCapTools is a no-op when within budget', () => {
  const tools = [T('a'), T('b'), T('c')];
  const r = rankAndCapTools(tools, 'anything', 5);
  assert.deepEqual(r.kept, tools);
  assert.deepEqual(r.hidden, []);
});

test('rankAndCapTools keeps the most task-relevant tools', () => {
  const tools = [
    T('mcp_gh_create_issue', 'open a github issue'),
    T('mcp_slack_post', 'post a slack message'),
    T('mcp_gh_list_prs', 'list github pull requests'),
    T('mcp_calendar_add', 'add a calendar event'),
  ];
  const { kept, hidden } = rankAndCapTools(tools, 'open a github pull request for the issue', 2);
  const keptNames = kept.map((t) => t.name);
  assert.equal(kept.length, 2);
  assert.ok(keptNames.includes('mcp_gh_create_issue'), 'github tool kept');
  assert.ok(keptNames.includes('mcp_gh_list_prs'), 'github PR tool kept');
  assert.equal(hidden.length, 2);
});

test('rankAndCapTools is stable when there is no signal (empty task)', () => {
  const tools = [T('a'), T('b'), T('c'), T('d')];
  const { kept } = rankAndCapTools(tools, '', 2);
  assert.deepEqual(kept.map((t) => t.name), ['a', 'b']); // first N, original order
});

test('rankAndCapTools with budget 0 hides nothing (cap disabled)', () => {
  const tools = [T('a'), T('b')];
  assert.deepEqual(rankAndCapTools(tools, 'x', 0).hidden, []);
});

test('toolRelevanceScore counts distinct task-token hits in name+description', () => {
  const tokens = new Set(['github', 'issue']);
  assert.equal(toolRelevanceScore(T('mcp_gh_create_issue', 'open a github issue'), tokens), 2);
  assert.equal(toolRelevanceScore(T('mcp_slack_post', 'post a message'), tokens), 0);
});

test('applyToolScope whitelists allow and removes disallow (suffix-aware)', () => {
  const tools = [T('mcp_gh_create_issue'), T('mcp_gh_list_prs'), T('mcp_slack_post')];
  // allow only the gh tools (bare-name suffix match).
  const allowed = applyToolScope(tools, { allow: ['create_issue', 'list_prs'] });
  assert.deepEqual(allowed.map((t) => t.name), ['mcp_gh_create_issue', 'mcp_gh_list_prs']);
  // disallow trumps: drop list_prs even when allowed.
  const minusOne = applyToolScope(tools, { allow: ['create_issue', 'list_prs'], disallow: ['list_prs'] });
  assert.deepEqual(minusOne.map((t) => t.name), ['mcp_gh_create_issue']);
  // no scope → unchanged.
  assert.deepEqual(applyToolScope(tools).map((t) => t.name), tools.map((t) => t.name));
});
