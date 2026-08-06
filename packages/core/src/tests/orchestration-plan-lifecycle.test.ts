import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bundledOrchestrationProfileReferences,
  findBundledOrchestrationProfile,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  resolveWorkspaceOrchestrationPlan,
  type WorkspaceOrchestrationResolutionInput,
} from '../orchestration/profiles/orchestrationProfileResolver.js';
import {
  EphemeralOrchestrationPlanLifecycle,
  OrchestrationStageLaunchRejectedError,
  type OrchestrationLifecycleOwner,
} from '../orchestration/profiles/orchestrationPlanLifecycle.js';
import { getWorkspaceProfile } from '../workspace/profiles.js';

const owner: OrchestrationLifecycleOwner = {
  turnId: 'turn-1',
  sessionKey: 'session-1',
};

function resolved(strategyId: 'direct' | 'investigate') {
  const definition = findBundledOrchestrationProfile('engineering');
  const preset = getWorkspaceProfile('engineering');
  const references = bundledOrchestrationProfileReferences();
  assert.ok(definition);
  assert.ok(preset);
  const input: WorkspaceOrchestrationResolutionInput = {
    definition,
    manifest: {
      profile: 'engineering',
      orchestration: structuredClone(preset.orchestration),
    },
    taskSignalIds: new Set(),
    roleCatalog: references.roles,
    installedSkillIds: references.skillIds,
    workspaceSkillIds: references.skillIds,
    delegationPolicy: 'auto',
    runtimeLimits: {
      maxConcurrentChildren: 3,
      providerAvailableSlots: 3,
    },
    explicitStrategyId: strategyId,
  };
  return resolveWorkspaceOrchestrationPlan(input);
}

test('P23-3a direct stays primary-only while investigate admits only its explorer stage', () => {
  const direct = new EphemeralOrchestrationPlanLifecycle(owner, resolved('direct'));
  assert.throws(
    () => direct.beginDelegation('complete', 'explorer', owner),
    (error) =>
      error instanceof OrchestrationStageLaunchRejectedError &&
      error.reason === 'executor-mismatch' &&
      /primary-only/.test(error.message),
  );
  direct.beginPrimary('complete', owner);
  direct.finishStage('complete', 'succeeded');
  assert.equal(direct.snapshot()[0]?.state, 'succeeded');

  const investigate = new EphemeralOrchestrationPlanLifecycle(owner, resolved('investigate'));
  investigate.beginDelegation('inspect', 'explorer', owner);
  investigate.finishStage('inspect', 'succeeded');
  // The primary cannot conclude while the adversary is still outstanding — that
  // gate is the whole value of the challenge stage. Running it (or explicitly
  // skipping it, since it is optional) is what unblocks the synthesis.
  assert.throws(
    () => investigate.beginPrimary('synthesize', owner),
    (error) =>
      error instanceof OrchestrationStageLaunchRejectedError &&
      /waiting for "challenge"/.test(error.message),
  );
  investigate.beginDelegation('challenge', 'reviewer', owner);
  investigate.finishStage('challenge', 'succeeded');
  investigate.beginPrimary('synthesize', owner);
  investigate.finishStage('synthesize', 'succeeded');
  assert.deepEqual(
    investigate.snapshot().map((stage) => [stage.id, stage.state]),
    [['inspect', 'succeeded'], ['challenge', 'succeeded'], ['synthesize', 'succeeded']],
  );
});

test('P23-3a interruption cancels unstarted ephemeral stages without replay data', () => {
  const lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, resolved('investigate'));
  lifecycle.terminate('turn-interrupted');

  assert.deepEqual(
    lifecycle.snapshot().map((stage) => [stage.id, stage.state, stage.terminalReason]),
    [
      ['inspect', 'cancelled', 'turn-interrupted'],
      ['challenge', 'cancelled', 'turn-interrupted'],
      ['synthesize', 'cancelled', 'turn-interrupted'],
    ],
  );
  assert.throws(
    () => lifecycle.beginDelegation('inspect', 'explorer', owner),
    (error) =>
      error instanceof OrchestrationStageLaunchRejectedError &&
      error.reason === 'lifecycle-closed',
  );
  assert.equal('toolArgs' in lifecycle, false);
});

test('P23-3a a session switch closes the old owner and cancels its unstarted stages', () => {
  const lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, resolved('investigate'));
  assert.throws(
    () => lifecycle.beginDelegation('inspect', 'explorer', {
      turnId: 'turn-2',
      sessionKey: 'session-2',
    }),
    (error) =>
      error instanceof OrchestrationStageLaunchRejectedError &&
      error.reason === 'owner-mismatch',
  );
  assert.equal(
    lifecycle.snapshot().every(
      (stage) => stage.state === 'cancelled' && stage.terminalReason === 'session-changed',
    ),
    true,
  );
});

test('P23-3a missing runtime is one terminal non-retryable diagnostic', () => {
  const lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, resolved('investigate'));
  assert.deepEqual(lifecycle.recordRuntimeUnavailable('inspect'), {
    code: 'orchestration-runtime-unavailable',
    stageId: 'inspect',
    terminal: true,
    retryable: false,
  });
  assert.equal(lifecycle.recordRuntimeUnavailable('inspect'), undefined);
  assert.deepEqual(
    lifecycle.snapshot().map((stage) => [stage.id, stage.state, stage.terminalReason]),
    [
      ['inspect', 'failed', 'runtime-unavailable'],
      ['challenge', 'cancelled', 'runtime-unavailable'],
      ['synthesize', 'cancelled', 'runtime-unavailable'],
    ],
  );
});
