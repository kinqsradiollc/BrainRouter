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
import {
  judgeOptimizationRound,
  engineeringBuildLoopRound,
  executionDecisionKindFor,
} from '../orchestration/execution/optimizationSubgraph.js';

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

// ── A40-11 — build-loop optimization decisions reach the map ─────────────────

test('A40-11 — an optimization decision the build loop made is projected into the map', () => {
  // The critic gate scores the run; the loop's `accepted` flag decides. This
  // records that decision through the shared vocabulary so the map can show it.
  // Mutation-proof: drop the `payload.decision` line in phasePlanAdapter and the
  // decision never reaches `snapshot.decisions`, failing this.
  const emitter = canonicalPhasePlanEmitter(INPUT);
  emitter.hooks.onPhaseStart?.(phase('implement'), 0, 1);
  emitter.hooks.onPhaseComplete?.(execution('implement', 'completed'));

  const verdict = judgeOptimizationRound({
    targetMetricId: 'critic_score',
    counterMetricIds: [],
    baseline: [{ metricId: 'critic_score', value: 0.7 }],
    candidate: [{ metricId: 'critic_score', value: 0.9 }],
    verifierPassed: true,
  });
  assert.equal(verdict.accept, true, 'a rising score with a passing verifier accepts');
  emitter.emitDecision(
    { kind: executionDecisionKindFor(verdict.kind), outcome: 'accepted', reasonCodes: verdict.reasonCodes },
    'critic-gate',
  );
  emitter.finish({ status: 'completed', phases: [] } as PhasePlanExecution);

  const snap = reduceExecutionEvents(emitter.events()).snapshot(INPUT.executionId)!;
  const decision = snap.decisions.find((d) => d.nodeExecutionId === 'critic-gate');
  assert.ok(decision, 'the optimization decision is projected into the execution map');
  assert.equal(decision!.outcome, 'accepted');
  assert.ok(decision!.reasonCodes.length > 0, 'it carries the verdict reason codes, not a raw error string');
});

test('A40-11 — the retained Engineering merge shim rejects a held build and accepts a merged one', () => {
  // The mapping Seam 2 uses: verify-green -> pass_rate, review-approval -> the
  // lint_errors counter-metric (a block is a regression). `merged` still decides
  // upstream; this only checks the recorded verdict matches the outcome.
  const held = engineeringBuildLoopRound({ passRateBefore: 0, passRateAfter: 0, lintErrorsBefore: 0, lintErrorsAfter: 1, verifierPassed: false });
  assert.equal(held.accept, false, 'verify-red / review-blocked records as a rejection');
  const merged = engineeringBuildLoopRound({ passRateBefore: 0, passRateAfter: 1, lintErrorsBefore: 0, lintErrorsAfter: 0, verifierPassed: true });
  assert.equal(merged.accept, true, 'verify-green / review-approved records as an acceptance');
});
