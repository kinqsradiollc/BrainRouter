/**
 * ADR-040 A40-9 goal-continuation + A40-5 goal grouping.
 *
 * A goal has no id of its own — it is identified by its scope and the moment it
 * was set — so "which runs happened under this goal" is a link the runtime has
 * to MAKE, not one it can look up. These pin that the link is made once, at
 * launch, from the emitted event; that it survives a durable write; and that a
 * run with no goal is simply absent from the grouping rather than silently
 * folded into someone else's goal. Each failure here is quiet: a goal index that
 * never populates just answers "no runs", which is indistinguishable from a real
 * empty goal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { ExecutionSessionStore } from '../orchestration/execution/reducer.js';
import { runGraphAsCanonicalExecution } from '../orchestration/execution/graphAdapter.js';
import type { WorkflowGraph } from '../workflow/graph/graph.js';
import type { GraphRunDeps } from '../workflow/graph/graphEngine.js';
import {
  startDurableRun,
  updateDurableRun,
  readDurableRunSafe,
  listDurableRuns,
} from '../orchestration/execution/runStore.js';
import { toRunsListRows, toRunDetailView } from '../orchestration/execution/runsView.js';

function event(
  executionId: string,
  sequence: number,
  payload: unknown,
  sessionKey: string,
  goalId?: string,
): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `${executionId}-${sequence}`,
    executionId,
    executionSequence: sequence,
    sessionKey,
    ...(goalId !== undefined ? { goalId } : {}),
    emittedAt: '2026-08-16T00:00:00.000Z',
    payload,
  };
}

// ── reducer: the grouping index ────────────────────────────────────────────

test('executions are grouped by the goal they were launched under', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'running' }, 'sess', 'g1'));
  store.apply(event('e2', 1, { status: 'running' }, 'sess', 'g1'));
  store.apply(event('e3', 1, { status: 'running' }, 'sess', 'g2'));
  // Mutation-proof: if #byGoal indexing is dropped, these collapse to [].
  assert.deepEqual([...store.executionsForGoal('g1')].sort(), ['e1', 'e2']);
  assert.deepEqual([...store.executionsForGoal('g2')], ['e3']);
  assert.deepEqual([...store.executionsForGoal('unknown')], []);
});

test('a run with no goal is absent from every goal group, but still grouped by session', () => {
  // The dangerous failure is the opposite: a no-goal run quietly indexed under
  // some default goal key, so a goal listing shows runs that never belonged to it.
  const store = new ExecutionSessionStore();
  store.apply(event('n1', 1, { status: 'running' }, 'sess')); // no goal
  store.apply(event('g', 1, { status: 'running' }, 'sess', 'g1'));
  assert.deepEqual([...store.executionsForGoal('g1')], ['g'], 'only the goal-linked run');
  assert.deepEqual([...store.executionsForSession('sess')].sort(), ['g', 'n1'], 'both are still session-grouped');
  assert.equal(store.snapshot('n1')!.goalId, undefined, 'the no-goal run carries no goal');
});

test('the goal link is set once and is sticky — a later event without it does not unset it', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'running' }, 'sess', 'g1'));
  store.apply(event('e1', 2, { nodeId: 'n', status: 'succeeded' }, 'sess')); // no goalId on the later event
  assert.equal(store.snapshot('e1')!.goalId, 'g1');
  assert.deepEqual([...store.executionsForGoal('g1')], ['e1']);
});

test('forgetSession clears the goal index too — a forgotten run cannot reappear under its goal', () => {
  const store = new ExecutionSessionStore();
  store.apply(event('e1', 1, { status: 'succeeded' }, 'leaving', 'g1'));
  store.apply(event('k1', 1, { status: 'running' }, 'kept', 'g1'));
  store.forgetSession('leaving');
  assert.deepEqual([...store.executionsForGoal('g1')], ['k1'], 'only the kept session survives in the goal group');
});

// ── end-to-end: a real graph run carries its goal through to the durable record ──

const echo: GraphRunDeps = { runAgent: async (p) => `AGENT(${p})` };
function oneStep(): WorkflowGraph {
  return {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'a', type: 'agent', data: { prompt: 'x' } },
      { id: 'o', type: 'output', data: { template: 'done' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'o' },
    ],
  };
}

test('a graph run launched under a goal carries the goal into both the snapshot and the durable record', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-goal-')));
  try {
    const { snapshot, durable } = await runGraphAsCanonicalExecution({
      graph: oneStep(),
      deps: echo,
      executionId: 'exec-goal',
      runId: 'run-goal',
      sessionKey: 'sess',
      goalId: 'sess:2026-08-16T00:00:00.000Z',
      workspaceRoot: dir,
      startedAt: '2026-08-16T00:00:00.000Z',
      definitionId: 'one-step',
    });
    // Mutation-proof: drop `goalId` from the emitted event and both fall to undefined/null.
    assert.equal(snapshot.goalId, 'sess:2026-08-16T00:00:00.000Z', 'the reduced snapshot knows its goal');
    assert.equal(durable!.goalId, 'sess:2026-08-16T00:00:00.000Z', 'the durable record persisted its goal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── durable store: persist, survive an update, filter ──────────────────────

test('goalId persists through a durable write, survives a status update, and filters the listing', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-goal-store-')));
  try {
    startDurableRun({ workspaceRoot: dir, runId: 'r1', executionId: 'x1', goalId: 'gA', startedAt: '2026-08-16T00:00:00.000Z' });
    startDurableRun({ workspaceRoot: dir, runId: 'r2', executionId: 'x2', goalId: 'gB', startedAt: '2026-08-16T00:00:01.000Z' });
    startDurableRun({ workspaceRoot: dir, runId: 'r3', executionId: 'x3', startedAt: '2026-08-16T00:00:02.000Z' }); // no goal

    assert.equal(readDurableRunSafe(dir, 'r1')!.goalId, 'gA');
    // Survives a later update — the CAS path spreads the existing record.
    updateDurableRun(dir, 'r1', { status: 'succeeded', endedAt: '2026-08-16T00:01:00.000Z' });
    assert.equal(readDurableRunSafe(dir, 'r1')!.goalId, 'gA', 'goal survives the status write');

    const gA = listDurableRuns(dir, { goalId: 'gA' }).runs;
    assert.deepEqual(gA.map((r) => r.runId), ['r1'], 'the filter returns only gA runs');
    const all = listDurableRuns(dir, {}).runs;
    assert.equal(all.length, 3, 'an unfiltered listing still shows every run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── view: both hosts surface the goal ──────────────────────────────────────

test('the shared projection carries the goal into the listing row and the detail view', () => {
  const rec = {
    schemaVersion: 1, runId: 'r1', executionId: 'x1', definitionId: 'd', definitionHash: 'h',
    goalId: 'gA', subworkflowHashes: [], status: 'succeeded', startedAt: '2026-08-16T00:00:00.000Z', revision: 1,
  } as const;
  assert.equal(toRunsListRows([rec])[0]!.goalId, 'gA', 'the row carries the goal');
  // Even with no retained events (unavailable), the goal is known from the record.
  assert.equal(toRunDetailView(rec, undefined).goalId, 'gA', 'the detail knows its goal without a snapshot');
});
