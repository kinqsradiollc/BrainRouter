import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceManifest,
  WORKSPACE_MANIFEST_VERSION,
} from '@kinqs/brainrouter-core/workspace';
import {
  applyProjectOnboardingEdits,
  createProjectOnboardingDraft,
  parseProjectOnboardingList,
} from '../cli/commands/init/onboardingDraft.js';

const root = '/Users/dev/example';

test('engineering drafts use one engineer with frontend and backend task capabilities', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'engineering' });
  assert.equal(draft.persona.default, 'engineer');
  assert.deepEqual(draft.persona.enabled, ['engineer']);
  assert.equal(draft.orchestration.mode, 'adaptive');
  assert.deepEqual(draft.orchestration.disabledRoles, ['fleet']);
  assert.deepEqual(draft.capabilities.enabled, ['frontend', 'backend']);
  assert.ok(!JSON.stringify(draft).includes('frontend-builder'));
});

test('same-profile edits preserve normalized forward fields without sharing arrays', () => {
  const existing = {
    ...createWorkspaceManifest({ name: 'example', profile: 'research', by: 'import', at: '2026-01-02T03:04:05.000Z' }),
    extra: { future: { enabled: true } },
  };
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'research', existing });
  assert.deepEqual(draft, existing);
  assert.notEqual(draft.persona.enabled, existing.persona.enabled);
  assert.notEqual(draft.orchestration.availableRoles, existing.orchestration.availableRoles);
  assert.notEqual(draft.extra, existing.extra);
});

test('profile changes reset preset fields while retaining identity and safe forward fields', () => {
  const existing = {
    ...createWorkspaceManifest({ name: 'kept-name', profile: 'research', by: 'import', at: '2026-01-02T03:04:05.000Z' }),
    version: 7,
    instructions: 'PROJECT.md',
    extra: { futureFlag: true },
  };
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'engineering', existing });
  assert.equal(draft.name, 'kept-name');
  assert.equal(draft.version, WORKSPACE_MANIFEST_VERSION);
  assert.deepEqual(draft.onboarded, existing.onboarded);
  assert.equal(draft.instructions, 'PROJECT.md');
  assert.deepEqual(draft.extra, { futureFlag: true });
  assert.deepEqual(draft.persona.enabled, ['engineer']);
  assert.equal(draft.orchestration.mode, 'adaptive');
  assert.deepEqual(draft.capabilities.enabled, ['frontend', 'backend']);
});

test('reviewed edits de-duplicate fields, include the default persona, and honor denies', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'custom' });
  const edited = applyProjectOnboardingEdits(draft, {
    personaDefault: ' engineer ',
    personasEnabled: ['researcher', 'researcher'],
    orchestrationMode: 'adaptive',
    orchestrationAvailableRoles: ['worker', 'reviewer', 'worker', 'fleet'],
    orchestrationDisabledRoles: ['fleet', 'fleet'],
    orchestrationMaxParallel: 3,
    capabilitiesEnabled: ['frontend', 'frontend', 'browser'],
    capabilitiesDisabled: ['browser'],
    skillPacks: ['engineering', 'engineering'],
    skillsEnabled: ['testing-skill'],
    skillsDisabled: [],
    toolProfiles: ['coding', 'coding'],
    toolsDenied: ['shell:unsafe'],
    memoryTags: ['engineering', 'engineering'],
    memoryCaptureHint: ' code ',
    instructions: ' AGENT.md ',
  });
  assert.deepEqual(edited.persona.enabled, ['engineer', 'researcher']);
  assert.deepEqual(edited.agents, edited.persona);
  assert.deepEqual(edited.orchestration, {
    mode: 'adaptive',
    availableRoles: ['worker', 'reviewer'],
    disabledRoles: ['fleet'],
    maxParallel: 3,
  });
  assert.deepEqual(edited.capabilities.enabled, ['frontend']);
  assert.deepEqual(edited.capabilities.disabled, ['browser']);
  assert.deepEqual(edited.skills.packs, ['engineering']);
  assert.deepEqual(edited.tools.profiles, ['coding']);
  assert.equal(edited.memory.captureHint, 'code');
  assert.equal(edited.instructions, 'AGENT.md');
});

test('comma-separated editor fields trim and de-duplicate deterministically', () => {
  assert.deepEqual(parseProjectOnboardingList(' browser, terminal, browser, , coding '), [
    'browser', 'terminal', 'coding',
  ]);
});
