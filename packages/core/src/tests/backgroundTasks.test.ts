import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectDashboardTasks, collectRunningTasks, formatBackgroundTasks, groupTasksByKind, summarizeTasks, shellRunToTask, type BackgroundTask } from '../background/backgroundTasks.js';
import { createSession, updateSession } from '../orchestration/session/orchestrator.js';
import { createWorker } from '../worker/workerStore.js';
import { createBackgroundTask, updateBackgroundTask } from '../background/backgroundTaskStore.js';

const TASKS: BackgroundTask[] = [
  { kind: 'agent', id: 'agent-1', label: 'reviewer (agent-1)' },
  { kind: 'workflow', id: 'migrate', label: 'migrate' },
  { kind: 'worker', id: 'w7', label: 'w7 · builder' },
];

test('summarizeTasks: counts per kind, omits zero kinds, pluralizes', () => {
  assert.equal(summarizeTasks(TASKS), '1 workflow · 1 worker · 1 agent');
  assert.equal(summarizeTasks([{ kind: 'agent', id: 'a', label: 'a' }, { kind: 'agent', id: 'b', label: 'b' }]), '2 agents');
  assert.equal(summarizeTasks([]), '');
});

test('formatBackgroundTasks: empty → [] (panel hides)', () => {
  assert.deepEqual(formatBackgroundTasks([]), []);
});

test('formatBackgroundTasks: workflows first, then workers, then agents', () => {
  const lines = formatBackgroundTasks(TASKS);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /⟳ workflow migrate/);
  assert.match(lines[1], /◆ worker w7 · builder/);
  assert.match(lines[2], /◐ agent reviewer \(agent-1\)/);
});

test('formatBackgroundTasks: caps the list with an overflow summary', () => {
  const many: BackgroundTask[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'agent', id: `a${i}`, label: `a${i}` }));
  const lines = formatBackgroundTasks(many, { max: 3 });
  assert.equal(lines.length, 4); // 3 + overflow
  assert.match(lines[3], /…and 7 more/);
});

test('groupTasksByKind: splits into agent / worker / workflow, preserving order', () => {
  const groups = groupTasksByKind([
    ...TASKS,
    { kind: 'agent', id: 'agent-2', label: 'second' },
  ]);
  assert.deepEqual(groups.agent.map((t) => t.id), ['agent-1', 'agent-2']);
  assert.deepEqual(groups.worker.map((t) => t.id), ['w7']);
  assert.deepEqual(groups.workflow.map((t) => t.id), ['migrate']);
});

test('groupTasksByKind: empty input yields one empty bucket per kind', () => {
  const groups = groupTasksByKind([]);
  assert.deepEqual(groups, { agent: [], worker: [], workflow: [], shell: [] });
});

// Sidebar data contract: a sub-agent spawned by the orchestrator must surface
// as a running kind:'agent' task so the sidebar's Sub-agents section can show
// it. (Regression guard for "spawned sub-agents don't appear in the sidebar".)
test('collectRunningTasks surfaces a running child session as kind "agent" + a worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-bgtasks-'));
  try {
    const child = createSession(dir, { role: 'explorer', prompt: 'map auth', parentSessionKey: 'parent' });
    updateSession(dir, child.id, { status: 'running' });
    createWorker(dir, { role: 'builder', goal: 'build x', id: 'wkr_t1', pid: process.pid });

    const tasks = collectRunningTasks(dir);
    const agentTask = tasks.find((t) => t.kind === 'agent');
    assert.ok(agentTask, 'a running child session must surface as a kind:agent task');
    assert.equal(agentTask!.id, child.id);
    assert.ok(agentTask!.startedAt, 'agent task carries startedAt for the elapsed display');
    assert.ok(tasks.some((t) => t.kind === 'worker' && t.id === 'wkr_t1'), 'running worker must surface too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectRunningTasks carries the agent role + worktree flag for the sidebar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-bgtasks-wt-'));
  try {
    // A reviewer running in an isolated git worktree...
    const wt = createSession(dir, { role: 'reviewer', prompt: 'review diff', parentSessionKey: 'parent' });
    updateSession(dir, wt.id, {
      status: 'running',
      childWorkspaceIsolation: { kind: 'git-worktree', sourceRoot: dir, worktreeRoot: '/tmp/wt-xyz' },
    });
    // ...and a plain explorer with no worktree.
    const plain = createSession(dir, { role: 'explorer', prompt: 'map', parentSessionKey: 'parent' });
    updateSession(dir, plain.id, { status: 'running' });

    const byId = new Map(collectRunningTasks(dir).map((t) => [t.id, t]));
    assert.equal(byId.get(wt.id)?.role, 'reviewer');
    assert.equal(byId.get(wt.id)?.worktree, true, 'isolated child → worktree:true');
    assert.equal(byId.get(plain.id)?.role, 'explorer');
    assert.equal(byId.get(plain.id)?.worktree, false, 'non-isolated child → worktree:false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectDashboardTasks includes recent failed durable tasks and stale child agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-dashboard-tasks-'));
  try {
    const stale = createSession(dir, { role: 'reviewer', prompt: 'review diff', parentSessionKey: 'parent' });
    updateSession(dir, stale.id, { status: 'stale', error: 'Host exited' });
    const running = createSession(dir, { role: 'explorer', prompt: 'map', parentSessionKey: 'parent' });
    updateSession(dir, running.id, { status: 'running' });
    const review = createBackgroundTask(dir, { kind: 'review', title: 'Review working changes', sessionKey: 'parent', status: 'running' });
    updateBackgroundTask(dir, review.id, { status: 'failed', error: 'Review failed' });

    const rows = collectDashboardTasks(dir);
    const byKey = new Map(rows.map((t) => [`${t.kind}:${t.id}`, t]));
    assert.equal(byKey.get(`agent:${stale.id}`)?.status, 'stale');
    assert.equal(byKey.get(`agent:${running.id}`)?.status, 'running');
    assert.equal(byKey.get(`review:${review.id}`)?.status, 'failed');
    assert.ok(!collectRunningTasks(dir).some((t) => t.id === stale.id), 'stale agents are dashboard-visible but not running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WS2: shellRunToTask surfaces a RUNNING background shell as a fleet task', () => {
  const task = shellRunToTask({ id: 'bg-1', command: 'npm run dev', pid: 1234, status: 'running', exitCode: null, logPath: '/tmp/bg-1.log', startedAt: 1_700_000_000_000 });
  assert.ok(task, 'a running shell maps to a task');
  assert.equal(task?.kind, 'shell');
  assert.equal(task?.id, 'bg-1');
  assert.equal(task?.label, 'npm run dev');
  assert.equal(typeof task?.startedAt, 'string', 'startedAt normalized to ISO');
});

test('WS2: a finished/failed background shell is NOT surfaced', () => {
  assert.equal(shellRunToTask({ id: 'b', command: 'echo hi', pid: 1, status: 'done', exitCode: 0, logPath: '/tmp/b.log', startedAt: 1 }), null);
  assert.equal(shellRunToTask({ id: 'c', command: 'false', pid: 1, status: 'failed', exitCode: 1, logPath: '/tmp/c.log', startedAt: 1 }), null);
});
