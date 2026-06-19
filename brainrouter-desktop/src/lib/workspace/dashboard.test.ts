import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskMatchesTab,
  taskLifecycle,
  taskStatusLabel,
  isActiveTask,
  filterTasks,
  countByTab,
  mergeWorkspaceDashboards,
  allTasks,
  visibleDashboardBoards,
  type DashTask,
  type WorkspaceDash,
} from './dashboard.js';

const T = (over: Partial<DashTask>): DashTask => ({ kind: 'sub-agent', id: 'x', label: 'l', ...over });

test('taskMatchesTab — lifecycle tabs key off status', () => {
  assert.equal(taskMatchesTab(T({ status: 'running' }), 'running'), true);
  assert.equal(taskMatchesTab(T({ status: 'completed' }), 'running'), false);
  assert.equal(taskMatchesTab(T({ status: 'completed' }), 'finished'), true);
  assert.equal(taskMatchesTab(T({ status: 'failed' }), 'failed'), true);
  assert.equal(taskMatchesTab(T({ status: 'failed' }), 'running'), false, 'failed is not running');
  assert.equal(taskMatchesTab(T({ status: 'stale' }), 'failed'), true, 'stale is an attention state');
  assert.equal(taskMatchesTab(T({ status: 'interrupted' }), 'failed'), true, 'interrupted is an attention state');
  assert.equal(taskMatchesTab(T({ status: 'stale' }), 'running'), false, 'stale is not running');
  assert.equal(taskMatchesTab(T({ status: undefined }), 'running'), true, 'no status → treated as running');
});

test('taskLifecycle + status label normalize dashboard status consistently', () => {
  assert.equal(taskLifecycle(T({ status: 'running' })), 'running');
  assert.equal(taskLifecycle(T({ status: 'completed' })), 'finished');
  assert.equal(taskLifecycle(T({ status: 'running', phase: 'error-reading-transcript' })), 'failed');
  assert.equal(isActiveTask(T({ status: 'stale' })), false);
  assert.equal(taskStatusLabel(T({ status: 'plan-revision' })), 'plan revision');
  assert.equal(taskStatusLabel(T({ phase: 'collecting-diff' })), 'collecting diff');
});

test('taskMatchesTab — kind tabs (a finished workflow still shows under Workflows)', () => {
  assert.equal(taskMatchesTab(T({ kind: 'workflow', status: 'completed' }), 'workflows'), true);
  assert.equal(taskMatchesTab(T({ kind: 'sub-agent' }), 'agents'), true);
  assert.equal(taskMatchesTab(T({ kind: 'worker' }), 'agents'), true);
  assert.equal(taskMatchesTab(T({ kind: 'bash' }), 'bash'), true);
  assert.equal(taskMatchesTab(T({ kind: 'run_command' }), 'bash'), true);
  assert.equal(taskMatchesTab(T({ kind: 'workflow' }), 'agents'), false);
});

test('filterTasks + countByTab', () => {
  const tasks = [T({ kind: 'workflow', status: 'running' }), T({ kind: 'sub-agent', status: 'completed' }), T({ kind: 'bash', status: 'failed' })];
  assert.equal(filterTasks(tasks, 'running').length, 1);
  assert.equal(filterTasks(tasks, 'workflows').length, 1);
  const c = countByTab(tasks);
  assert.deepEqual({ running: c.running, finished: c.finished, failed: c.failed, workflows: c.workflows, agents: c.agents, bash: c.bash },
    { running: 1, finished: 1, failed: 1, workflows: 1, agents: 1, bash: 1 });
});

test('mergeWorkspaceDashboards prefers live, stamps roots, never cross-attributes', () => {
  const disk: WorkspaceDash[] = [
    { workspaceRoot: '/A', tasks: [T({ id: 'a1' })] },
    { workspaceRoot: '/B', tasks: [T({ id: 'b1' })] },
  ];
  const live = { '/A': { workspaceRoot: '/A', tasks: [T({ id: 'a-live' })] } as WorkspaceDash };
  const merged = mergeWorkspaceDashboards(disk, live);
  assert.deepEqual(merged.map((m) => m.workspaceRoot), ['/A', '/B'], 'sorted, deduped by root');
  assert.equal(merged.find((m) => m.workspaceRoot === '/A')!.tasks[0].id, 'a-live', 'live overrides disk for /A');
  // every task carries its OWN workspaceRoot — no leakage
  for (const b of merged) for (const t of b.tasks) assert.equal(t.workspaceRoot, b.workspaceRoot);
  assert.equal(allTasks(merged).length, 2);
});

test('mergeWorkspaceDashboards preserves durable task transcript metadata', () => {
  const disk: WorkspaceDash[] = [
    {
      workspaceRoot: '/A',
      tasks: [T({
        kind: 'review',
        id: 'review-1',
        durable: true,
        status: 'running',
        phase: 'reviewing',
        parentSessionKey: 'chat:a',
        transcript: { kind: 'task', id: 'review-1', parentSessionKey: 'review:review-1' },
      })],
    },
  ];
  const [merged] = mergeWorkspaceDashboards(disk, {});
  const task = merged.tasks[0];
  assert.equal(task.workspaceRoot, '/A');
  assert.equal(task.durable, true);
  assert.equal(task.phase, 'reviewing');
  assert.deepEqual(task.transcript, { kind: 'task', id: 'review-1', parentSessionKey: 'review:review-1' });
});

test('visibleDashboardBoards hides empty clean all-workspace cards but keeps actionable gates', () => {
  const boards: WorkspaceDash[] = [
    { workspaceRoot: '/empty-clean', tasks: [], reviewGate: { status: 'clean', blocked: false, reason: '' } },
    { workspaceRoot: '/empty-stale', tasks: [], reviewGate: { status: 'stale', blocked: true, reason: 'Diff changed.' } },
    { workspaceRoot: '/failed-task', tasks: [T({ id: 'f', status: 'failed' })] },
  ];

  assert.deepEqual(
    visibleDashboardBoards(boards, 'failed', 'all').map((b) => b.workspaceRoot),
    ['/empty-stale', '/failed-task'],
  );
  assert.deepEqual(
    visibleDashboardBoards(boards, 'running', 'all').map((b) => b.workspaceRoot),
    ['/empty-stale'],
  );
  assert.equal(visibleDashboardBoards(boards.slice(0, 1), 'running', 'workspace').length, 1, 'workspace scope keeps its empty-state board');
});
