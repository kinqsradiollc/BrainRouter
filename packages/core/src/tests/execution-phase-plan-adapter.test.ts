/**
 * ADR-040 A40-7 — phase-plan runs adapted to the canonical execution map.
 *
 * The emitter is a pure hook factory, so these drive it the way
 * `executePhasePlan` would — onPhaseStart / onPhaseComplete / finish — and
 * assert the canonical projection. The mapping that matters is `partial ->
 * degraded`: a phase that lost some children must not read as a clean success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PhaseExecution, PhasePlanExecution } from '../orchestration/workflow/phaseOrchestrator.js';
import type { WorkflowPhase } from '../orchestration/workflow/phasePlan.js';
import {
  canonicalPhasePlanEmitter,
  phaseStatusToCanonical,
} from '../orchestration/execution/phasePlanAdapter.js';
import { reduceExecutionEvents } from '../orchestration/execution/reducer.js';

function phase(id: string): WorkflowPhase {
  return { id, title: id } as WorkflowPhase;
}

function execution(id: string, status: PhaseExecution['status'], childIds: string[] = []): PhaseExecution {
  return {
    id,
    title: id,
    status,
    children: childIds.map((cid) => ({ id: cid, role: 'worker', status: 'completed' })),
    output: '',
  };
}

const INPUT = {
  executionId: 'exec-pp-1',
  sessionKey: 'sess-1',
  startedAt: '2026-08-16T00:00:00.000Z',
};

test('a completed phase plan projects one succeeded occurrence per phase', () => {
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('plan'), 0, 2);
  emitter.hooks.onPhaseComplete?.(execution('plan', 'completed'));
  emitter.hooks.onPhaseStart?.(phase('build'), 1, 2);
  emitter.hooks.onPhaseComplete?.(execution('build', 'completed'));
  emitter.finish({ status: 'completed', phases: [] } as PhasePlanExecution);

  const snap = emitter.snapshot()!;
  assert.equal(snap.status, 'succeeded');
  assert.equal(snap.completeness, 'complete');
  assert.equal(snap.occurrences.length, 2);
  assert.deepEqual(snap.occurrences.map((o) => o.status).sort(), ['succeeded', 'succeeded']);
});

test('a partial phase is DEGRADED, not succeeded — and so is the run', () => {
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('build'), 0, 1);
  emitter.hooks.onPhaseComplete?.(execution('build', 'partial'));
  emitter.finish({ status: 'partial', phases: [] } as PhasePlanExecution);

  const snap = emitter.snapshot()!;
  assert.equal(snap.occurrences.find((o) => o.nodeId === 'build')!.status, 'degraded');
  assert.equal(snap.status, 'degraded');
});

test('a failed phase plan is failed', () => {
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('build'), 0, 1);
  emitter.hooks.onPhaseComplete?.(execution('build', 'failed'));
  emitter.finish({ status: 'failed', phases: [] } as PhasePlanExecution);
  assert.equal(emitter.snapshot()!.status, 'failed');
});

test('phase children become the stage\'s child sessions, correlated back to the stage', () => {
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('map'), 0, 1);
  emitter.hooks.onPhaseComplete?.(execution('map', 'completed', ['child-a', 'child-b']));
  emitter.finish({ status: 'completed', phases: [] } as PhasePlanExecution);

  // Re-project the emitted stream through a fresh store and check correlation.
  const store = reduceExecutionEvents(emitter.events());
  assert.equal(store.executionForChildSession('child-a'), 'exec-pp-1');
  assert.equal(store.executionForChildSession('child-b'), 'exec-pp-1');
  const occ = store.snapshot('exec-pp-1')!.occurrences.find((o) => o.nodeId === 'map')!;
  assert.deepEqual([...occ.childSessionIds].sort(), ['child-a', 'child-b']);
});

test('the emitted stream is contiguous, so the reducer never reports a gap', () => {
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('a'), 0, 1);
  emitter.hooks.onPhaseComplete?.(execution('a', 'completed'));
  emitter.finish({ status: 'completed', phases: [] } as PhasePlanExecution);

  const seqs = emitter.events().map((e) => e.executionSequence);
  assert.deepEqual(seqs, [1, 2, 3, 4], 'running, phase-start, phase-complete, finish');
  assert.equal(reduceExecutionEvents(emitter.events()).snapshot('exec-pp-1')!.completeness, 'complete');
});

test('phaseStatusToCanonical is a total, honest mapping', () => {
  assert.equal(phaseStatusToCanonical('completed'), 'succeeded');
  assert.equal(phaseStatusToCanonical('partial'), 'degraded');
  assert.equal(phaseStatusToCanonical('failed'), 'failed');
});
