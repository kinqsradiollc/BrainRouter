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
    ['planning-skill', 'adr-skill'],
  );
  assert.match(requiredSkillActivationPrompt(activation), /Before the first mutating tool call/);
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
    }),
    { required: [] },
  );
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
