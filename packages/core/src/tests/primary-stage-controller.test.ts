/**
 * Primary-stage controller contract tests.
 *
 * These tests keep multi-skill sequencing, dependency gates, and turn-owned
 * fail-closed behavior independent from the Agent transport loop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrimaryStageActionRejectedError,
  PrimaryStageController,
  type PrimaryStageSkillActivation,
} from '../orchestration/runtime/primaryStageController.js';
import type {
  ResolvedOrchestrationStage,
  ResolvedWorkspaceOrchestrationPlan,
} from '../orchestration/profiles/orchestrationProfileResolver.js';

const OWNER = { turnId: 'turn-1', sessionKey: 'session-1' };

function stage(input: Partial<ResolvedOrchestrationStage> & {
  id: string;
  executor: ResolvedOrchestrationStage['executor'];
}): ResolvedOrchestrationStage {
  return {
    id: input.id,
    executor: input.executor,
    after: input.after ?? [],
    objective: input.objective ?? `Complete ${input.id}.`,
    skillIds: input.skillIds ?? [],
    optional: input.optional ?? false,
    requiresApproval: input.requiresApproval ?? false,
    ...(input.fanOut ? { fanOut: input.fanOut } : {}),
    ...(input.expectedOutput ? { expectedOutput: input.expectedOutput } : {}),
  };
}

function plan(stages: ResolvedOrchestrationStage[]): Pick<ResolvedWorkspaceOrchestrationPlan, 'stages'> {
  return { stages };
}

function skill(id: string): PrimaryStageSkillActivation {
  return {
    id,
    instructions: `Instructions for ${id}.`,
    allowedTools: id === 'question' ? ['read_file'] : ['fetch_url'],
    disallowedTools: [],
  };
}

test('primary stage runs every declared skill before unlocking its dependent', async () => {
  let active: PrimaryStageSkillActivation | undefined;
  const controller = new PrimaryStageController(
    OWNER,
    plan([
      stage({
        id: 'frame',
        executor: { kind: 'primary' },
        skillIds: ['question', 'source-plan'],
      }),
      stage({
        id: 'collect',
        executor: { kind: 'primary' },
        after: ['frame'],
        skillIds: ['evidence'],
      }),
    ]),
    {
      loadSkill: async (id) => skill(id),
      setActiveSkill: (next) => { active = next; },
    },
  );

  const beganQuestion = JSON.parse(await controller.invoke({
    action: 'begin',
    stageId: 'frame',
    skillId: 'question',
  }));
  assert.equal(beganQuestion.activeSkill, 'question');
  assert.deepEqual(beganQuestion.allowedTools, ['read_file']);
  assert.equal(active?.id, 'question');
  assert.deepEqual(controller.nextRequiredAction(), {
    action: 'complete',
    stageId: 'frame',
    skillId: 'question',
    optional: false,
  });

  await assert.rejects(
    controller.invoke({ action: 'begin', stageId: 'collect', skillId: 'evidence' }),
    (error: unknown) => error instanceof PrimaryStageActionRejectedError,
  );

  const completedQuestion = JSON.parse(await controller.invoke({
    action: 'complete',
    stageId: 'frame',
    skillId: 'question',
  }));
  assert.equal(completedQuestion.action, 'completed-skill');
  assert.deepEqual(completedQuestion.remainingSkillIds, ['source-plan']);
  assert.equal(active, undefined);
  assert.deepEqual(controller.nextRequiredAction(), {
    action: 'begin',
    stageId: 'frame',
    skillId: 'source-plan',
    optional: false,
  });

  const beganSourcePlan = JSON.parse(await controller.invoke({
    action: 'begin',
    stageId: 'frame',
    skillId: 'source-plan',
  }));
  assert.equal(beganSourcePlan.activeSkill, 'source-plan');
  assert.deepEqual(beganSourcePlan.allowedTools, ['fetch_url']);

  const completedFrame = JSON.parse(await controller.invoke({
    action: 'complete',
    stageId: 'frame',
  }));
  assert.equal(completedFrame.action, 'completed-stage');
  assert.equal(completedFrame.stages.find((item: any) => item.id === 'frame').state, 'succeeded');
  assert.deepEqual(controller.nextRequiredAction(), {
    action: 'begin',
    stageId: 'collect',
    skillId: 'evidence',
    optional: false,
  });

  const beganCollect = JSON.parse(await controller.invoke({
    action: 'begin',
    stageId: 'collect',
  }));
  assert.equal(beganCollect.activeSkill, 'evidence');
});

test('primary stage rejects role stages, undeclared skills, and required skips', async () => {
  const controller = new PrimaryStageController(
    OWNER,
    plan([
      stage({ id: 'review', executor: { kind: 'role', roleId: 'reviewer' } }),
      stage({ id: 'write', executor: { kind: 'primary' }, skillIds: ['draft'] }),
    ]),
    {
      loadSkill: async (id) => skill(id),
      setActiveSkill: () => {},
    },
  );

  await assert.rejects(
    controller.invoke({ action: 'begin', stageId: 'review' }),
    (error: unknown) => (
      error instanceof PrimaryStageActionRejectedError
      && error.reason === 'executor-mismatch'
    ),
  );
  await assert.rejects(
    controller.invoke({ action: 'begin', stageId: 'write', skillId: 'unknown' }),
    (error: unknown) => (
      error instanceof PrimaryStageActionRejectedError
      && error.reason === 'skill-unexpected'
    ),
  );
  await assert.rejects(
    controller.invoke({ action: 'skip', stageId: 'write' }),
    (error: unknown) => (
      error instanceof PrimaryStageActionRejectedError
      && error.reason === 'stage-required'
    ),
  );
});

test('missing skill fails the stage and clears active policy', async () => {
  let active: PrimaryStageSkillActivation | undefined = skill('existing');
  const controller = new PrimaryStageController(
    OWNER,
    plan([stage({ id: 'frame', executor: { kind: 'primary' }, skillIds: ['missing'] })]),
    {
      loadSkill: async () => { throw new Error('file disappeared'); },
      setActiveSkill: (next) => { active = next; },
    },
  );

  await assert.rejects(
    controller.invoke({ action: 'begin', stageId: 'frame' }),
    (error: unknown) => (
      error instanceof PrimaryStageActionRejectedError
      && error.reason === 'skill-unavailable'
    ),
  );
  assert.equal(active, undefined);
  assert.equal(controller.snapshot()[0].state, 'failed');
});

test('optional primary stage can skip only before another stage starts', async () => {
  const controller = new PrimaryStageController(
    OWNER,
    plan([
      stage({ id: 'optional', executor: { kind: 'primary' }, optional: true }),
      stage({ id: 'required', executor: { kind: 'primary' } }),
    ]),
    {
      loadSkill: async (id) => skill(id),
      setActiveSkill: () => {},
    },
  );

  const skipped = JSON.parse(await controller.invoke({ action: 'skip', stageId: 'optional' }));
  assert.equal(skipped.action, 'skipped-stage');
  assert.equal(skipped.stages.find((item: any) => item.id === 'optional').state, 'skipped');

  await controller.invoke({ action: 'begin', stageId: 'required' });
  const completed = JSON.parse(await controller.invoke({ action: 'complete', stageId: 'required' }));
  assert.equal(completed.action, 'completed-stage');
});

test('optional stages cannot skip unresolved dependencies', async () => {
  const controller = new PrimaryStageController(
    OWNER,
    plan([
      stage({ id: 'required', executor: { kind: 'primary' } }),
      stage({
        id: 'optional-after',
        executor: { kind: 'primary' },
        after: ['required'],
        optional: true,
      }),
    ]),
    {
      loadSkill: async (id) => skill(id),
      setActiveSkill: () => {},
    },
  );

  assert.equal(controller.nextRequiredAction(), undefined);
  await assert.rejects(
    controller.invoke({ action: 'skip', stageId: 'optional-after' }),
    (error: unknown) => (
      error instanceof PrimaryStageActionRejectedError
      && error.reason === 'stage-not-ready'
    ),
  );

  await controller.invoke({ action: 'begin', stageId: 'required' });
  assert.equal(controller.nextRequiredAction(), undefined);
  await controller.invoke({ action: 'complete', stageId: 'required' });
  const skipped = JSON.parse(await controller.invoke({
    action: 'skip',
    stageId: 'optional-after',
  }));
  assert.equal(skipped.action, 'skipped-stage');
});
