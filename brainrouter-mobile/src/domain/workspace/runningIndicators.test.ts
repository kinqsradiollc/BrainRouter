import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRunCounts, runningWorkspaceSet } from './runningIndicators.js';

test('workspaceRunCounts: non-active from global boards, active from live fleet', () => {
  const boards = [
    { workspaceRoot: '/A', tasks: [{}, {}] },   // 2 durable tasks
    { workspaceRoot: '/B', tasks: [] },         // idle
  ];
  // Active workspace is B, with 1 live fleet task — overrides the board's 0.
  const counts = workspaceRunCounts(boards, '/B', 1);
  assert.equal(counts.get('/A'), 2);
  assert.equal(counts.get('/B'), 1);
});

test('workspaceRunCounts: tolerates null boards / missing tasks', () => {
  const counts = workspaceRunCounts(null, '/A', 0);
  assert.equal(counts.get('/A'), 0);
  const counts2 = workspaceRunCounts([{ workspaceRoot: '/X' }], null, 0);
  assert.equal(counts2.get('/X'), 0);
});

test('runningWorkspaceSet: unions live turns with active-task workspaces', () => {
  const live = new Set<string>(['/B']);            // a live turn in B
  const counts = new Map<string, number>([['/A', 2], ['/B', 0], ['/C', 0]]);
  const set = runningWorkspaceSet(live, counts);
  assert.ok(set.has('/A'), 'A has durable tasks → running');
  assert.ok(set.has('/B'), 'B has a live turn → running');
  assert.ok(!set.has('/C'), 'C is idle');
});

test('regression: a background task in workspace A stays "running" while viewing B', () => {
  // The user is in workspace B (active). Workspace A has a running plan-revision
  // task. The sidebar indicator for A must remain on, sourced from global state.
  const activeRoot = '/B';
  const boards = [
    { workspaceRoot: '/A', tasks: [{ kind: 'plan-revision', id: 'btask_1' }] },
    { workspaceRoot: '/B', tasks: [] },
  ];
  const counts = workspaceRunCounts(boards, activeRoot, 0); // B has 0 live tasks
  const live = new Set<string>();                            // no live turns
  const running = runningWorkspaceSet(live, counts);
  assert.ok(running.has('/A'), 'A indicator remains visible from B');
  assert.equal(counts.get('/A'), 1, 'A shows its running-task count');
  assert.ok(!running.has('/B'), 'B (active, idle) shows nothing');
});

test('workspaceRunCounts: terminal and stale dashboard rows do not count as running', () => {
  const boards = [
    { workspaceRoot: '/A', tasks: [{ kind: 'review', id: 'done', status: 'completed' }, { kind: 'agent', id: 'stale', status: 'stale' }] },
    { workspaceRoot: '/B', tasks: [{ kind: 'review', id: 'active', status: 'queued' }] },
  ];
  const counts = workspaceRunCounts(boards, null, 0);
  assert.equal(counts.get('/A'), 0, 'completed/stale rows are visible in Dashboard but not active');
  assert.equal(counts.get('/B'), 1, 'queued rows still count as active');
  const running = runningWorkspaceSet(new Set(), counts);
  assert.ok(!running.has('/A'));
  assert.ok(running.has('/B'));
});
