import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '@kinqs/brainrouter-types';
import { parseTrackQuery, matchesTrackQuery } from '../track/query.js';

function wi(p: Partial<WorkItem>): WorkItem {
  return {
    id: p.id ?? 'wi', key: p.key ?? 'BR-1', type: p.type ?? 'task', title: p.title ?? 'Item',
    status: p.status ?? 'todo', statusCategory: p.statusCategory ?? 'unstarted', priority: p.priority ?? 'medium',
    assignees: p.assignees ?? (p.assignee ? [p.assignee] : []), assignee: p.assignee, reporter: p.reporter, watchers: [], labels: p.labels ?? [], components: [],
    sprintId: p.sprintId, epicId: p.epicId, links: [], comments: [], attachmentIds: [], activity: [],
    workspaceRoot: '/tmp', linkedMemoryIds: [], codeLinks: [], taskIds: [], artifactIds: [], reviewFindingIds: [],
    description: p.description, createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
  };
}

test('query: empty matches everything', () => {
  const p = parseTrackQuery('');
  assert.ok(p.ok && p.pred!(wi({})));
});

test('query: equality + inequality + contains', () => {
  assert.ok(matchesTrackQuery(wi({ status: 'done' }), 'status = done'));
  assert.ok(!matchesTrackQuery(wi({ status: 'todo' }), 'status = done'));
  assert.ok(matchesTrackQuery(wi({ status: 'todo' }), 'status != done'));
  assert.ok(matchesTrackQuery(wi({ title: 'Fix the reranker' }), 'text ~ reranker'));
  assert.ok(!matchesTrackQuery(wi({ title: 'Fix the board' }), 'text ~ reranker'));
});

test('query: priority comparison by rank', () => {
  assert.ok(matchesTrackQuery(wi({ priority: 'high' }), 'priority >= high'));
  assert.ok(matchesTrackQuery(wi({ priority: 'urgent' }), 'priority >= high'));
  assert.ok(!matchesTrackQuery(wi({ priority: 'medium' }), 'priority >= high'));
  assert.ok(matchesTrackQuery(wi({ priority: 'low' }), 'priority < medium'));
});

test('query: AND binds tighter than OR; parens override', () => {
  const w = wi({ type: 'bug', priority: 'low', status: 'todo' });
  // bug AND high(false) OR todo(true) → true
  assert.ok(matchesTrackQuery(w, 'type = bug AND priority = high OR status = todo'));
  // (bug AND high) → false; with parens forcing the AND, OR todo still true
  assert.ok(matchesTrackQuery(w, '(type = bug AND priority = high) OR status = todo'));
  // bug AND (high OR todo-as-status... ) — group the OR
  assert.ok(matchesTrackQuery(w, 'type = bug AND (priority = high OR priority = low)'));
  assert.ok(!matchesTrackQuery(w, 'type = bug AND (priority = high OR priority = highest)'));
});

test('query: in (list) + labels membership', () => {
  assert.ok(matchesTrackQuery(wi({ type: 'bug' }), 'type in (bug, story)'));
  assert.ok(!matchesTrackQuery(wi({ type: 'task' }), 'type in (bug, story)'));
  assert.ok(matchesTrackQuery(wi({ labels: ['memory', 'cli'] }), 'label = memory'));
  assert.ok(!matchesTrackQuery(wi({ labels: ['desktop'] }), 'label = memory'));
});

test('query: quoted values + assignee', () => {
  assert.ok(matchesTrackQuery(wi({ assignee: 'ann dale' }), 'assignee = "ann dale"'));
});

test('query: parse errors are structured, not thrown', () => {
  assert.equal(parseTrackQuery('status =').ok, false);
  assert.equal(parseTrackQuery('bogus = x').ok, false);
  assert.equal(parseTrackQuery('(status = done').ok, false);
  assert.match(parseTrackQuery('bogus = x').error!, /unknown field/);
});
