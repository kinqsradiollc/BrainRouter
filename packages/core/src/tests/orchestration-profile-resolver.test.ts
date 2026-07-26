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
import { getWorkspaceProfile } from '../workspace/profiles.js';

function input(
  overrides: Partial<WorkspaceOrchestrationResolutionInput> = {},
): WorkspaceOrchestrationResolutionInput {
  const definition = findBundledOrchestrationProfile('engineering');
  const preset = getWorkspaceProfile('engineering');
  const references = bundledOrchestrationProfileReferences();
  assert.ok(definition);
  assert.ok(preset);
  return {
    definition,
    manifest: {
      profile: 'engineering',
      orchestration: structuredClone(preset.orchestration),
    },
    taskSignalIds: new Set(['implementation']),
    roleCatalog: references.roles,
    installedSkillIds: references.skillIds,
    workspaceSkillIds: references.skillIds,
    delegationPolicy: 'auto',
    runtimeLimits: {
      maxConcurrentChildren: 3,
      providerAvailableSlots: 2,
    },
    ...overrides,
  };
}

test('P23-3 deterministically resolves and narrows the Engineering delivery preview', () => {
  const result = resolveWorkspaceOrchestrationPlan(input());

  assert.equal(result.activation, 'preview');
  assert.equal(result.orchestrationProfileId, 'engineering');
  assert.equal(result.strategyId, 'delivery');
  assert.equal(result.selectionSource, 'deterministic');
  assert.deepEqual(result.matchedSignalIds, ['implementation']);
  assert.equal(result.effectiveParallel, 2);
  assert.equal(result.stages.find((stage) => stage.id === 'inspect')?.fanOut?.max, 2);
  assert.equal(result.stages.find((stage) => stage.id === 'implement')?.fanOut?.max, 1);
  assert.deepEqual(result.skippedStages, []);
});

test('P23-3 applies workspace, CLI, and provider parallel ceilings', () => {
  const manifest = input().manifest!;
  manifest.orchestration.maxParallel = 1;
  const result = resolveWorkspaceOrchestrationPlan(input({
    manifest,
    runtimeLimits: {
      maxConcurrentChildren: 8,
      providerAvailableSlots: 4,
    },
  }));

  assert.equal(result.effectiveParallel, 1);
  assert.equal(result.stages.find((stage) => stage.id === 'inspect')?.fanOut?.max, 1);
});

test('P23-3 skips unavailable optional stages and falls back for mandatory gaps', () => {
  const all = input();
  const withoutPlanning = new Set(
    [...all.workspaceSkillIds].filter((skillId) => skillId !== 'planning-skill'),
  );
  const optionalSkip = resolveWorkspaceOrchestrationPlan(input({
    workspaceSkillIds: withoutPlanning,
  }));
  assert.equal(optionalSkip.strategyId, 'delivery');
  assert.equal(optionalSkip.stages.some((stage) => stage.id === 'inspect'), false);
  assert.deepEqual(optionalSkip.skippedStages, [{
    code: 'skill-unavailable',
    referenceId: 'planning-skill',
    strategyId: 'delivery',
    stageId: 'inspect',
  }]);

  const manifest = input().manifest!;
  manifest.orchestration.availableRoles =
    manifest.orchestration.availableRoles.filter((roleId) => roleId !== 'worker');
  const mandatoryGap = resolveWorkspaceOrchestrationPlan(input({ manifest }));
  assert.equal(mandatoryGap.strategyId, 'direct');
  assert.equal(mandatoryGap.selectionSource, 'fallback');
  assert.equal(
    mandatoryGap.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'role-unavailable' &&
        diagnostic.referenceId === 'worker',
    ),
    true,
  );
});

test('P23-3 uses capability skills only when installed and preserves delegation gates', () => {
  const base = input();
  const withoutIncremental = new Set(
    [...base.workspaceSkillIds].filter((skillId) => skillId !== 'incremental-skill'),
  );
  const result = resolveWorkspaceOrchestrationPlan(input({
    workspaceSkillIds: withoutIncremental,
    capabilitySkillIds: new Set(['incremental-skill', 'not-installed']),
    delegationPolicy: 'ask-before-write-child',
  }));

  assert.equal(result.strategyId, 'delivery');
  assert.equal(result.stages.find((stage) => stage.id === 'inspect')?.requiresApproval, false);
  assert.equal(result.stages.find((stage) => stage.id === 'implement')?.requiresApproval, true);
});

test('P23-3 fails closed to the declared fallback for disabled delegation or capacity', () => {
  const disabled = resolveWorkspaceOrchestrationPlan(input({
    delegationPolicy: 'no-children',
  }));
  assert.equal(disabled.strategyId, 'direct');
  assert.equal(
    disabled.diagnostics.some((diagnostic) => diagnostic.code === 'delegation-disabled'),
    true,
  );

  const noCapacity = resolveWorkspaceOrchestrationPlan(input({
    runtimeLimits: {
      maxConcurrentChildren: 8,
      providerAvailableSlots: 0,
    },
  }));
  assert.equal(noCapacity.strategyId, 'direct');
  assert.equal(noCapacity.effectiveParallel, 0);
  assert.equal(
    noCapacity.diagnostics.some(
      (diagnostic) => diagnostic.code === 'parallel-capacity-unavailable',
    ),
    true,
  );

  const invalidCapacity = resolveWorkspaceOrchestrationPlan(input({
    runtimeLimits: {
      maxConcurrentChildren: 8,
      providerAvailableSlots: Number.NaN,
    },
  }));
  assert.equal(invalidCapacity.strategyId, 'direct');
  assert.equal(invalidCapacity.effectiveParallel, 0);
});

test('P23-3 respects off, explicit, and skipped-setup no-manifest primary paths', () => {
  const offManifest = input().manifest!;
  offManifest.orchestration.mode = 'off';
  const off = resolveWorkspaceOrchestrationPlan(input({ manifest: offManifest }));
  assert.equal(off.strategyId, 'direct');
  assert.deepEqual(off.diagnostics.map((diagnostic) => diagnostic.code), [
    'mode-off',
    'fallback-selected',
  ]);

  const explicitManifest = input().manifest!;
  explicitManifest.orchestration.mode = 'explicit';
  const explicitPrimary = resolveWorkspaceOrchestrationPlan(input({
    manifest: explicitManifest,
  }));
  assert.equal(explicitPrimary.strategyId, 'direct');
  assert.equal(explicitPrimary.selectionSource, 'fallback');

  const explicitDelivery = resolveWorkspaceOrchestrationPlan(input({
    manifest: explicitManifest,
    explicitStrategyId: 'delivery',
  }));
  assert.equal(explicitDelivery.strategyId, 'delivery');
  assert.equal(explicitDelivery.selectionSource, 'explicit');

  const legacy = resolveWorkspaceOrchestrationPlan(input({ manifest: null }));
  assert.equal(legacy.orchestrationProfileId, null);
  assert.equal(legacy.strategyId, null);
  assert.deepEqual(legacy.stages.map((stage) => stage.executor.kind), ['primary']);
  assert.equal(legacy.diagnostics[0]?.code, 'no-manifest');
});

test('P23-3 fails closed for a mismatched profile plan or invalid fallback', () => {
  const mismatched = input();
  mismatched.manifest!.profile = 'research';
  const mismatchResult = resolveWorkspaceOrchestrationPlan(mismatched);
  assert.equal(mismatchResult.orchestrationProfileId, null);
  assert.equal(mismatchResult.diagnostics[0]?.code, 'profile-plan-mismatch');

  const invalid = structuredClone(input().definition!);
  invalid.fallbackStrategyId = 'missing';
  const invalidResult = resolveWorkspaceOrchestrationPlan(input({ definition: invalid }));
  assert.equal(invalidResult.orchestrationProfileId, null);
  assert.equal(invalidResult.diagnostics[0]?.code, 'invalid-plan');
});
