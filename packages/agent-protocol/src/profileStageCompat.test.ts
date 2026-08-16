/**
 * ADR-040 A40-4 — the legacy profile-stage view, projected from the canonical map.
 *
 * The mappings that matter are the lossy edges: `degraded` must not green into
 * success, `interrupted` is a cancel not an error, a retried node shows its
 * retry, and `terminated`/`resolved`/`updated` track the run's real phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ExecutionRecord,
  ExecutionLogicalNode,
  ExecutionNodeOccurrence,
  NodeOccurrenceStatus,
  SelectionSource,
} from './executionMap.js';
import { emptyExecutionUsage } from './executionMap.js';
import {
  projectProfileStageView,
  toLegacyStageState,
  toLegacySelectionSource,
} from './profileStageCompat.js';

function record(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    schemaVersion: 1,
    executionId: 'exec-1',
    scopeKind: 'stage',
    sessionKey: 'sess-1',
    topology: 'profile-stages',
    workspaceProfileId: 'ws-prof',
    selectionSource: 'workspace-default',
    status: 'running',
    startedAt: '2026-08-16T00:00:00.000Z',
    inheritedBudget: null,
    usage: emptyExecutionUsage(),
    meteringState: 'unknown',
    selectionSignals: [],
    selectionDiagnostics: [],
    terminalReasonCodes: [],
    ...over,
  };
}
function node(nodeId: string, over: Partial<ExecutionLogicalNode> = {}): ExecutionLogicalNode {
  return {
    nodeId, kind: 'stage', boundedLabel: nodeId, executorKind: 'agent-loop',
    skillIds: [], declaredLimits: {}, ...over,
  };
}
function occ(nodeId: string, status: NodeOccurrenceStatus, attempt = 1, iterationPath: number[] = []): ExecutionNodeOccurrence {
  return {
    nodeExecutionId: `${nodeId}#${attempt}`, nodeId, attempt, iterationPath,
    status, childSessionIds: [], usage: emptyExecutionUsage(), terminalReasonCodes: [],
  };
}

test('toLegacyStageState — degraded reads as failed, never greened into success', () => {
  assert.equal(toLegacyStageState('degraded'), 'failed');
  // The rest of the lossy edges, pinned.
  assert.equal(toLegacyStageState('waiting-approval'), 'running');
  assert.equal(toLegacyStageState('interrupted'), 'cancelled');
  assert.equal(toLegacyStageState('blocked'), 'failed');
  assert.equal(toLegacyStageState('skipped'), 'skipped');
  // And the identity edges.
  for (const s of ['planned', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
    assert.equal(toLegacyStageState(s), s);
  }
});

test('toLegacySelectionSource — the five canonical sources map onto the four legacy ones', () => {
  const cases: Array<[SelectionSource, string]> = [
    ['explicit-user', 'explicit'],
    ['adaptive', 'adaptive-model'],
    ['fallback-direct', 'fallback'],
    ['workspace-default', 'deterministic'],
    ['inherited-goal', 'deterministic'],
  ];
  for (const [from, to] of cases) assert.equal(toLegacySelectionSource(from), to);
});

test('a degraded execution projects a degraded stage as failed AND is not a clean run', () => {
  const view = projectProfileStageView(
    record({ status: 'degraded' }),
    [node('build')],
    [occ('build', 'degraded')],
  );
  assert.equal(view.phase, 'terminated');
  assert.equal(view.stages[0].state, 'failed', 'degraded must not read as succeeded');
});

test('phase tracks the run: resolved before work, updated during, terminated after', () => {
  assert.equal(projectProfileStageView(record({ status: 'running' }), [node('a')], []).phase, 'resolved');
  assert.equal(projectProfileStageView(record({ status: 'running' }), [node('a')], [occ('a', 'running')]).phase, 'updated');
  assert.equal(projectProfileStageView(record({ status: 'succeeded' }), [node('a')], [occ('a', 'succeeded')]).phase, 'terminated');
});

test('a retried node shows its LATEST attempt, not its first', () => {
  const view = projectProfileStageView(
    record(),
    [node('impl')],
    [occ('impl', 'failed', 1), occ('impl', 'running', 2)],
  );
  assert.equal(view.stages[0].state, 'running', 'the attempt-2 retry wins over the attempt-1 failure');
});

test('executor + role + skills + node order are carried through faithfully', () => {
  const view = projectProfileStageView(
    record(),
    [
      node('review', { roleId: 'reviewer', skillIds: ['code-review'] }),
      node('plan'),
    ],
    [occ('review', 'running')],
  );
  assert.deepEqual(view.stages.map((s) => s.id), ['review', 'plan'], 'node order is stage order');
  assert.equal(view.stages[0].executor, 'role');
  assert.equal(view.stages[0].roleId, 'reviewer');
  assert.deepEqual(view.stages[0].skillIds, ['code-review']);
  assert.equal(view.stages[1].executor, 'primary', 'no roleId -> primary');
  assert.equal(view.stages[1].roleId, undefined);
});

test('profileId is the deprecated alias — plan profile, falling back to workspace', () => {
  const withPlan = projectProfileStageView(
    record({ workspaceProfileId: 'ws', planProfileId: 'plan', strategyId: 'strat' }),
    [], [],
  );
  assert.equal(withPlan.profileId, 'plan');
  assert.equal(withPlan.planProfileId, 'plan');
  assert.equal(withPlan.workspaceProfileId, 'ws');
  assert.equal(withPlan.strategyId, 'strat');

  const noPlan = projectProfileStageView(record({ workspaceProfileId: 'ws' }), [], []);
  assert.equal(noPlan.profileId, 'ws', 'falls back to workspace so a legacy reader never sees empty');
  assert.equal(noPlan.planProfileId, undefined, 'omitted, not forged, when absent');
  assert.equal(noPlan.strategyId, '', 'no canonical strategy -> empty, not invented');
});
