import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceManifest } from '../workspace/manifest.js';
import {
  requiredSkillActivationPrompt,
  resolveRequiredSkillActivation,
} from '../workspace/requiredSkillActivation.js';

test('profile and task workflow activation stays deterministic across representative prompts', () => {
  const researchOverride = createWorkspaceManifest({
    name: 'custom-research',
    profile: 'custom',
    by: 'wizard',
    overrides: { planning: { schemaId: 'research-evidence' } },
  });
  const fixtures = [
    {
      label: 'plan-only engineering review',
      prompt: 'Review this implementation plan only. Do not modify files.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
      expected: ['planning-skill'],
    },
    {
      label: 'routine engineering change',
      prompt: 'Rename this local label.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
      expected: [],
    },
    {
      label: 'engineering security boundary',
      prompt: 'Design the authorization permission model and decide its trade-offs.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' }),
      expected: ['adr-skill'],
    },
    {
      label: 'research campaign',
      prompt: 'Plan a deep research campaign with multiple deliverables.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: 'study', profile: 'research', by: 'wizard' }),
      expected: ['planning-skill', 'research-question-skill'],
    },
    {
      label: 'writing deliverables',
      prompt: 'Plan several deliverables for this publication.',
      activeGoal: false,
      manifest: createWorkspaceManifest({ name: 'copy', profile: 'writing', by: 'wizard' }),
      expected: ['planning-skill', 'structured-writing-skill'],
    },
    {
      label: 'active data-science goal',
      prompt: 'Continue.',
      activeGoal: true,
      manifest: createWorkspaceManifest({ name: 'analysis', profile: 'data-science', by: 'wizard' }),
      expected: ['planning-skill', 'experiment-validation-skill'],
    },
    {
      label: 'custom reviewed schema',
      prompt: 'Plan the evidence collection.',
      activeGoal: false,
      manifest: researchOverride,
      expected: ['planning-skill', 'research-question-skill'],
    },
    {
      label: 'unmanaged active goal fallback',
      prompt: 'Continue.',
      activeGoal: true,
      manifest: null,
      expected: ['planning-skill'],
    },
  ] as const;

  for (const fixture of fixtures) {
    const activation = resolveRequiredSkillActivation(fixture);
    assert.deepEqual(
      activation.required.map((skill) => skill.id),
      fixture.expected,
      fixture.label,
    );
    const prompt = requiredSkillActivationPrompt(activation);
    assert.doesNotMatch(prompt, /\b(?:Claude|Codex|OpenAI|Anthropic)\b/i, fixture.label);
    if (fixture.expected.length > 0) {
      assert.match(prompt, /Loading a skill never expands tool, profile, permission, or approval authority/);
    } else {
      assert.equal(prompt, '');
    }
  }
});
