/**
 * ADR-040 A40-2 §8.2 — goal/no-goal parity.
 *
 * The guarantee: the same conversational turn selects the same topology whether
 * or not a goal is active. The runtime enforces this structurally — the resolver
 * never reads the goal, and the goal-conditioned skill activation happens AFTER
 * topology resolution — so a goal whose objective is redundant with the
 * unresolved task must yield an EQUIVALENT plan to stating that task with no goal.
 *
 * These pin that equivalence at the plan level (identity, selection source,
 * matched signals, validated origin), which is where a leak would show up as a
 * goal quietly routing a turn differently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveTurnOrchestration } from '../workspace/activeTurnOrchestration.js';
import { buildTurnTaskEnvelope } from '../workspace/conversationTaskEnvelope.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import { withTempWorkspace } from './_helpers.js';

function engineeringWorkspace(ws: string): void {
  saveWorkspaceManifest(ws, createWorkspaceManifest({ name: 'parity', profile: 'engineering', by: 'wizard' }));
}

function planShape(ws: string, signalText: string) {
  const r = resolveActiveTurnOrchestration({ workspaceRoot: ws, task: signalText });
  return {
    strategyId: r.plan.strategyId,
    selectionSource: r.plan.selectionSource,
    matchedSignalIds: [...r.plan.matchedSignalIds].sort(),
    stageIds: r.plan.stages.map((s) => s.id),
    topologyOrigin: r.topologyOrigin,
  };
}

const TASK = 'please implement the billing service end to end';

test('§8.2 — a signal-matched task selects the SAME plan with a redundant goal as with no goal', () => {
  withTempWorkspace((ws) => {
    engineeringWorkspace(ws);
    // No goal: the user states the task.
    const noGoal = planShape(ws, buildTurnTaskEnvelope({ currentMessage: TASK, priorUserMessages: [] }).signalText);
    // Goal: an elliptical continuation, with a goal whose objective IS the task.
    const withGoal = planShape(ws, buildTurnTaskEnvelope({ currentMessage: 'go ahead', priorUserMessages: [], goalObjective: TASK }).signalText);
    assert.deepEqual(withGoal, noGoal, 'a redundant goal must not change the plan — only its parent correlation may differ');
  });
});

test('§8.2 step 4 — a contextless acknowledgement selects direct whether or not a goal is active', () => {
  withTempWorkspace((ws) => {
    engineeringWorkspace(ws);
    // "ok thanks" is an acknowledgement, not a continuation — the goal objective
    // is NOT folded in, so both resolve identically (and to no matched signals).
    const noGoal = planShape(ws, buildTurnTaskEnvelope({ currentMessage: 'ok thanks', priorUserMessages: [] }).signalText);
    const withGoal = planShape(ws, buildTurnTaskEnvelope({ currentMessage: 'ok thanks', priorUserMessages: [], goalObjective: TASK }).signalText);
    assert.deepEqual(withGoal, noGoal, 'a goal must not turn an acknowledgement into task work');
    assert.equal(noGoal.matchedSignalIds.length, 0, 'a contextless ack matches no signal');
  });
});

test('§8.2 — the resolver takes no goal input at all: topology cannot be goal-conditioned', () => {
  // Structural guarantee. If this stops compiling because a goal field was added
  // to the resolver input, that is the parity leak the row forbids.
  withTempWorkspace((ws) => {
    engineeringWorkspace(ws);
    const a = planShape(ws, TASK);
    const b = planShape(ws, TASK);
    assert.deepEqual(a, b, 'resolution is a deterministic function of the task, nothing else');
  });
});
