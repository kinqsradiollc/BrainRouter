import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkspaceOnboardingSources,
  buildWorkspaceSelectionCatalog,
  createWorkspaceManifest,
  workspaceProfilesForOnboarding,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceOnboardingSources,
} from '@kinqs/brainrouter-core/workspace';
import {
  applyProjectOnboardingEdits,
  createProjectOnboardingDraft,
  finalizeCatalogReviewedProjectOnboarding,
  parseProjectOnboardingList,
} from '../cli/commands/init/onboardingDraft.js';

const root = '/Users/dev/example';

type WorkspaceOrchestrationProfiles = WorkspaceOnboardingSources['orchestrationProfiles'];

function orchestrationProfiles(unavailableIds: string[] = []): WorkspaceOrchestrationProfiles {
  return {
    entries: new Map(),
    unavailableIds: new Set(unavailableIds),
    diagnostics: [],
  };
}

function marketingEdits(): Parameters<typeof finalizeCatalogReviewedProjectOnboarding>[1] {
  return {
    personaDefault: 'marketer',
    personasEnabled: ['marketer'],
    orchestrationMode: 'adaptive',
    orchestrationAvailableRoles: ['reviewer'],
    orchestrationDisabledRoles: ['fleet'],
    orchestrationMaxParallel: 3,
    capabilitiesEnabled: [],
    capabilitiesDisabled: [],
    skillPacks: [],
    skillsEnabled: [],
    skillsDisabled: [],
    toolProfiles: [
      'workspace-files',
      'project-knowledge',
      'memory-context',
      'artifacts',
      'planning-session',
      'browser',
    ],
    toolsEnabled: [],
    toolsDenied: [],
    memoryTags: ['marketing'],
    memoryCaptureHint: 'decisions',
    instructions: 'AGENT.md',
  };
}

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
    toolsEnabled: ['read_file', 'read_file'],
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

test('catalog-reviewed setup persists individual tools only through manifest v3', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'custom' });
  const reviewed = finalizeCatalogReviewedProjectOnboarding(draft, {
    personaDefault: '',
    personasEnabled: [],
    orchestrationMode: 'off',
    orchestrationAvailableRoles: [],
    orchestrationDisabledRoles: [],
    orchestrationMaxParallel: 1,
    capabilitiesEnabled: [],
    capabilitiesDisabled: [],
    skillPacks: [],
    skillsEnabled: [],
    skillsDisabled: [],
    toolProfiles: ['coding'],
    toolsEnabled: ['web_search', 'web_search'],
    toolsDenied: ['run_command'],
    memoryTags: [],
    memoryCaptureHint: '',
    instructions: '',
  }, buildWorkspaceSelectionCatalog());

  assert.equal(reviewed.version, 3);
  assert.equal(reviewed.tools.mode, 'explicit-catalog');
  assert.deepEqual(reviewed.tools.enabled, ['web_search']);
  assert.deepEqual(reviewed.tools.deny, ['run_command']);
});

test('catalog-reviewed setup rejects a free-text persona ID', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'custom' });
  assert.throws(
    () => finalizeCatalogReviewedProjectOnboarding(draft, {
      personaDefault: 'invented',
      personasEnabled: ['invented'],
      orchestrationMode: 'off',
      orchestrationAvailableRoles: [],
      orchestrationDisabledRoles: [],
      orchestrationMaxParallel: 1,
      capabilitiesEnabled: [],
      capabilitiesDisabled: [],
      skillPacks: [],
      skillsEnabled: [],
      skillsDisabled: [],
      toolProfiles: [],
      toolsEnabled: [],
      toolsDenied: [],
      memoryTags: [],
      memoryCaptureHint: '',
      instructions: '',
    }, buildWorkspaceSelectionCatalog()),
    /Reviewed persona selection is no longer available/,
  );
});

test('catalog-reviewed setup accepts roles from a declared bundled plan alias', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'marketing' });
  const reviewed = finalizeCatalogReviewedProjectOnboarding(
    draft,
    marketingEdits(),
    buildWorkspaceSelectionCatalog(),
    orchestrationProfiles(),
  );

  assert.deepEqual(reviewed.orchestration.availableRoles, ['reviewer']);
});

test('catalog-reviewed setup rejects roles when an invalid exact claim blocks alias fallback', () => {
  const draft = createProjectOnboardingDraft({ workspaceRoot: root, profile: 'marketing' });
  assert.throws(
    () => finalizeCatalogReviewedProjectOnboarding(
      draft,
      marketingEdits(),
      buildWorkspaceSelectionCatalog(),
      orchestrationProfiles(['marketing']),
    ),
    /Reviewed role selection is no longer available/,
  );
});

test('catalog-reviewed CLI finalization accepts every untouched workspace profile', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-draft-'));
  try {
    const sources = buildWorkspaceOnboardingSources(workspaceRoot);

    for (const profile of workspaceProfilesForOnboarding()) {
      const draft = createProjectOnboardingDraft({
        workspaceRoot,
        profile: profile.id,
        now: () => '2026-08-13T00:00:00.000Z',
      });
      const reviewed = finalizeCatalogReviewedProjectOnboarding(
        draft,
        {
          personaDefault: draft.persona.default,
          personasEnabled: [...draft.persona.enabled],
          orchestrationMode: draft.orchestration.mode,
          orchestrationAvailableRoles: [...draft.orchestration.availableRoles],
          orchestrationDisabledRoles: [...draft.orchestration.disabledRoles],
          orchestrationMaxParallel: draft.orchestration.maxParallel,
          capabilitiesEnabled: [...draft.capabilities.enabled],
          capabilitiesDisabled: [...draft.capabilities.disabled],
          skillPacks: [...draft.skills.packs],
          skillsEnabled: [...draft.skills.enabled],
          skillsDisabled: [...draft.skills.disabled],
          toolProfiles: [...draft.tools.profiles],
          toolsEnabled: [...(draft.tools.enabled ?? [])],
          toolsDenied: [...draft.tools.deny],
          memoryTags: [...draft.memory.tags],
          memoryCaptureHint: draft.memory.captureHint,
          instructions: draft.instructions,
        },
        sources.catalog,
        sources.orchestrationProfiles,
      );

      assert.equal(reviewed.profile, profile.id, `${profile.id}: workspace identity`);
      assert.equal(reviewed.orchestration.mode, profile.orchestration.mode, `${profile.id}: mode`);
      assert.equal(reviewed.version, 3, `${profile.id}: explicit catalog manifest`);
    }
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
