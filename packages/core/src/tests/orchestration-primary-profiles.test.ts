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
  type OrchestrationLifecycleOwner,
} from '../orchestration/profiles/orchestrationPlanLifecycle.js';
import {
  getWorkspaceProfile,
  type WorkspaceProfileId,
} from '../workspace/profiles.js';

function input(
  profileId: Extract<WorkspaceProfileId, 'study' | 'writing'>,
  signal: string,
  overrides: Partial<WorkspaceOrchestrationResolutionInput> = {},
): WorkspaceOrchestrationResolutionInput {
  const definition = findBundledOrchestrationProfile(profileId);
  const preset = getWorkspaceProfile(profileId);
  const references = bundledOrchestrationProfileReferences();
  assert.ok(definition);
  assert.ok(preset);
  return {
    definition,
    manifest: {
      profile: profileId,
      orchestration: structuredClone(preset.orchestration),
    },
    taskSignalIds: new Set([signal]),
    roleCatalog: references.roles,
    installedSkillIds: references.skillIds,
    workspaceSkillIds: references.skillIds,
    delegationPolicy: 'auto',
    runtimeLimits: {
      maxConcurrentChildren: 8,
      providerAvailableSlots: 8,
    },
    ...overrides,
  };
}

test('P23-6 Study plan matches its explicit preset and primary tutoring workflow', () => {
  const plan = findBundledOrchestrationProfile('study');
  const preset = getWorkspaceProfile('study');
  assert.ok(plan);
  assert.ok(preset);

  assert.equal(plan.defaultMode, 'explicit');
  assert.equal(plan.defaultMode, preset.orchestration.mode);
  assert.equal(plan.fallbackStrategyId, 'direct-tutoring');
  assert.deepEqual(plan.rolePolicy.availableRoles, preset.orchestration.availableRoles);
  assert.equal(plan.limits.maxParallel, preset.orchestration.maxParallel);
  assert.deepEqual(plan.strategies.map((strategy) => strategy.id), [
    'direct-tutoring',
    'diagnose-teach-check',
    'remediate',
    'source-explanation',
  ]);

  const guided = plan.strategies.find((strategy) => strategy.id === 'diagnose-teach-check');
  assert.deepEqual(guided?.stages.map((stage) => [stage.id, stage.executor.kind]), [
    ['diagnose', 'primary'],
    ['map-objective', 'primary'],
    ['teach', 'primary'],
    ['check', 'primary'],
  ]);
  assert.deepEqual(guided?.stages.flatMap((stage) => stage.skillIds), [
    'learner-diagnostic-skill',
    'learning-plan-skill',
    'tutoring-explanation-skill',
    'learning-assessment-skill',
  ]);
});

test('P23-6 Writing plan keeps outline, draft, and revision on its primary writer', () => {
  const plan = findBundledOrchestrationProfile('writing');
  const preset = getWorkspaceProfile('writing');
  assert.ok(plan);
  assert.ok(preset);

  assert.equal(plan.defaultMode, 'explicit');
  assert.equal(plan.defaultMode, preset.orchestration.mode);
  assert.equal(plan.fallbackStrategyId, 'direct-writing');
  assert.deepEqual(plan.rolePolicy.availableRoles, preset.orchestration.availableRoles);
  assert.equal(plan.limits.maxParallel, preset.orchestration.maxParallel);
  assert.deepEqual(plan.strategies.map((strategy) => strategy.id), [
    'direct-writing',
    'outline-draft-revise',
    'critique-revision',
  ]);

  const writing = plan.strategies.find((strategy) => strategy.id === 'outline-draft-revise');
  assert.deepEqual(writing?.stages.map((stage) => [stage.id, stage.executor.kind]), [
    ['outline', 'primary'],
    ['draft', 'primary'],
    ['revise', 'primary'],
  ]);
  assert.deepEqual(writing?.stages.flatMap((stage) => stage.skillIds), [
    'structured-writing-skill',
    'structured-writing-skill',
    'revision-skill',
  ]);
});

test('P23-6 explicit profiles stay direct until a strategy is reviewed and selected', () => {
  const study = resolveWorkspaceOrchestrationPlan(input(
    'study',
    'learning-assessment',
  ));
  assert.equal(study.strategyId, 'direct-tutoring');
  assert.equal(study.selectionSource, 'fallback');
  assert.equal(
    study.diagnostics.some((diagnostic) => diagnostic.code === 'explicit-mode-primary'),
    true,
  );

  const writing = resolveWorkspaceOrchestrationPlan(input(
    'writing',
    'critique',
  ));
  assert.equal(writing.strategyId, 'direct-writing');
  assert.equal(writing.selectionSource, 'fallback');
});

test('P23-6 primary-only strategies execute through the active-turn lifecycle without children', () => {
  const owner: OrchestrationLifecycleOwner = {
    turnId: 'turn-study',
    sessionKey: 'session-study',
  };
  const plan = resolveWorkspaceOrchestrationPlan(input(
    'study',
    'learning-assessment',
    { explicitStrategyId: 'diagnose-teach-check' },
  ));
  assert.equal(plan.strategyId, 'diagnose-teach-check');
  assert.equal(plan.selectionSource, 'explicit');
  assert.equal(plan.stages.every((stage) => stage.executor.kind === 'primary'), true);

  const lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, plan);
  for (const stage of plan.stages) {
    lifecycle.beginPrimary(stage.id, owner);
    lifecycle.finishStage(stage.id, 'succeeded');
  }
  assert.equal(
    lifecycle.snapshot().every((stage) =>
      stage.executorKind === 'primary' && stage.state === 'succeeded'),
    true,
  );
});

test('P23-6 every Study and Writing child remains read-only and cannot author revisions', () => {
  const references = bundledOrchestrationProfileReferences();
  for (const profileId of ['study', 'writing'] as const) {
    const plan = findBundledOrchestrationProfile(profileId);
    assert.ok(plan);
    for (const strategy of plan.strategies) {
      for (const stage of strategy.stages) {
        if (stage.executor.kind === 'primary') {
          assert.equal(stage.fanOut, undefined);
          assert.equal(stage.expectedOutput, undefined);
          continue;
        }
        assert.equal(
          references.roles.get(stage.executor.roleId)?.defaultAccess,
          'read',
          `${profileId}/${strategy.id}/${stage.id} exceeds read-only child authority`,
        );
        assert.equal(
          ['worker', 'architect', 'verifier'].includes(stage.executor.roleId),
          false,
        );
      }
      assert.equal(
        strategy.stages.at(-1)?.executor.kind,
        'primary',
        `${profileId}/${strategy.id} must finish on its primary persona`,
      );
    }
  }
});

test('P23-6 exceptional source gathering and critique narrow fan-out before primary completion', () => {
  const study = resolveWorkspaceOrchestrationPlan(input(
    'study',
    'source-explanation',
    {
      explicitStrategyId: 'source-explanation',
      runtimeLimits: {
        maxConcurrentChildren: 2,
        providerAvailableSlots: 1,
      },
    },
  ));
  assert.deepEqual(study.stages.map((stage) => [stage.id, stage.executor.kind]), [
    ['gather', 'role'],
    ['teach', 'primary'],
    ['check', 'primary'],
  ]);
  assert.equal(study.stages[0]?.fanOut?.max, 1);
  assert.deepEqual(study.stages[0]?.skillIds, ['learning-source-skill']);

  const writing = resolveWorkspaceOrchestrationPlan(input(
    'writing',
    'critique',
    { explicitStrategyId: 'critique-revision' },
  ));
  assert.deepEqual(writing.stages.map((stage) => [stage.id, stage.executor.kind]), [
    ['prepare', 'primary'],
    ['critique', 'role'],
    ['revise', 'primary'],
  ]);
  assert.equal(writing.stages[1]?.executor.kind, 'role');
  assert.equal(
    writing.stages[1]?.executor.kind === 'role'
      ? writing.stages[1].executor.roleId
      : undefined,
    'reviewer',
  );
  assert.deepEqual(writing.stages[1]?.skillIds, ['writing-critique-skill']);
});

test('P23-6 delegated stage skill gaps fail closed to primary handling', () => {
  for (const [profileId, signal, strategyId, missingSkill, fallback] of [
    ['study', 'source-explanation', 'source-explanation', 'learning-source-skill', 'direct-tutoring'],
    ['writing', 'critique', 'critique-revision', 'writing-critique-skill', 'direct-writing'],
  ] as const) {
    const base = input(profileId, signal);
    const result = resolveWorkspaceOrchestrationPlan(input(profileId, signal, {
      explicitStrategyId: strategyId,
      workspaceSkillIds: new Set(
        [...base.workspaceSkillIds].filter((skillId) => skillId !== missingSkill),
      ),
    }));

    assert.equal(result.strategyId, fallback);
    assert.equal(result.selectionSource, 'fallback');
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        diagnostic.code === 'skill-unavailable'
        && diagnostic.referenceId === missingSkill),
      true,
    );
  }
});

test('P23-6 a missing primary skill fails the selected strategy closed to direct handling', () => {
  const base = input('writing', 'writing-revision');
  const withoutRevision = new Set(
    [...base.workspaceSkillIds].filter((skillId) => skillId !== 'revision-skill'),
  );
  const result = resolveWorkspaceOrchestrationPlan(input(
    'writing',
    'writing-revision',
    {
      explicitStrategyId: 'outline-draft-revise',
      workspaceSkillIds: withoutRevision,
    },
  ));

  assert.equal(result.strategyId, 'direct-writing');
  assert.equal(result.selectionSource, 'fallback');
  assert.equal(
    result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'skill-unavailable'
      && diagnostic.referenceId === 'revision-skill'),
    true,
  );
});
