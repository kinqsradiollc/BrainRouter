import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredSkillActivationPrompt,
  requiredSkillsBlockingMutation,
  resolveRequiredSkillActivation,
} from '../workspace/requiredSkillActivation.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';

test('required skill activation applies shared Planning and ADR hard triggers', () => {
  const activation = resolveRequiredSkillActivation({
    prompt: 'Write an ADR to decide the cross-surface lifecycle contract, then plan the rollout.',
    activeGoal: false,
    manifest: createWorkspaceManifest({ name: 'app', profile: 'research', by: 'wizard' }),
  });
  assert.deepEqual(
    activation.required.map((skill) => skill.id),
    ['planning-skill', 'research-question-skill', 'adr-skill'],
  );
  assert.equal(activation.planningSchema.id, 'research-evidence');
  assert.match(requiredSkillActivationPrompt(activation), /host preflights each available required skill/i);
});

test('active goals require Planning while small obvious changes do not', () => {
  assert.deepEqual(
    resolveRequiredSkillActivation({
      prompt: 'Continue.',
      activeGoal: true,
      manifest: null,
    }).required.map((skill) => skill.id),
    ['planning-skill'],
  );
  assert.deepEqual(
    resolveRequiredSkillActivation({
      prompt: 'Rename this label.',
      activeGoal: false,
      manifest: null,
    }).required,
    [],
  );
});

test('P23-21 project initialization activates each profile planning contract', () => {
  for (const [profile, expected] of [
    ['engineering', ['planning-skill']],
    ['research', ['planning-skill', 'research-question-skill']],
    ['data-science', ['planning-skill', 'experiment-validation-skill']],
    ['study', ['planning-skill', 'learning-plan-skill']],
    ['writing', ['planning-skill', 'structured-writing-skill']],
    ['custom', ['planning-skill']],
  ] as const) {
    const activation = resolveRequiredSkillActivation({
      prompt: 'We are in an empty project folder. Help me set this workspace up.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: profile, profile, by: 'wizard' }),
    });
    assert.deepEqual(
      activation.required.map((skill) => skill.id),
      expected,
      `${profile} should initialize through its own planning schema`,
    );
  }
});

test('disabled hard-trigger skills fail safe and loaded skills satisfy the gate', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.skills.disabled = ['adr-skill'];
  const activation = resolveRequiredSkillActivation({
    prompt: 'Create an ADR for this architecture decision.',
    activeGoal: false,
    manifest,
  });
  assert.equal(activation.required[0]?.availability, 'disabled');
  assert.deepEqual(requiredSkillsBlockingMutation(activation, new Set()).map((skill) => skill.id), ['adr-skill']);

  const available = resolveRequiredSkillActivation({
    prompt: 'Plan the multi-stage implementation.',
    activeGoal: false,
    manifest,
  });
  assert.deepEqual(requiredSkillsBlockingMutation(available, new Set(['planning-skill'])), []);
});

test('reviewed workspace planning selection drives runtime skill activation', () => {
  const manifest = createWorkspaceManifest({
    name: 'custom',
    profile: 'custom',
    by: 'wizard',
    overrides: { planning: { schemaId: 'research-evidence' } },
  });
  const activation = resolveRequiredSkillActivation({
    prompt: 'Plan a deep research project.',
    activeGoal: false,
    manifest,
  });
  assert.equal(activation.planningSchema.id, 'research-evidence');
  assert.equal(activation.planningSchema.source, 'workspace-selection');
  assert.deepEqual(
    activation.required.map((skill) => skill.id),
    ['planning-skill', 'research-question-skill'],
  );
});

test('the active durable phase adds its required workflows without widening disabled skills', () => {
  const manifest = createWorkspaceManifest({
    name: 'app',
    profile: 'engineering',
    by: 'wizard',
  });
  manifest.skills.disabled = ['verify-loop'];
  const activation = resolveRequiredSkillActivation({
    prompt: 'Continue the current step.',
    activeGoal: true,
    manifest,
    phaseRequiredSkillIds: ['adr-skill', 'verify-loop', 'adr-skill'],
  });
  assert.deepEqual(
    activation.required.map((skill) => [skill.id, skill.availability]),
    [
      ['planning-skill', 'available'],
      ['adr-skill', 'available'],
      ['verify-loop', 'disabled'],
    ],
  );
});
