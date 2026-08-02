import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkspaceOnboardingPreview,
} from '../workspace/onboardingPreview.js';
import {
  createWorkspaceManifest,
  WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
} from '../workspace/manifest.js';
import {
  ORCHESTRATION_PLAN_ALIASES,
  resolveWorkspaceProfileOrchestrationDefaults,
  workspaceProfilesForOnboarding,
} from '../workspace/profileOrchestrationDefaults.js';
import { WORKSPACE_PROFILES } from '../workspace/profiles.js';

test('P23-8 every onboarding profile derives orchestration defaults from its bundled plan', () => {
  assert.equal(workspaceProfilesForOnboarding().length, WORKSPACE_PROFILES.length);
  for (const { id: profileId } of WORKSPACE_PROFILES) {
    const defaults = resolveWorkspaceProfileOrchestrationDefaults(profileId);
    const manifest = createWorkspaceManifest({ name: 'preview', profile: profileId, by: 'wizard' });
    assert.equal(defaults.source, 'orchestration-profile');
    // A domain profile may SHARE the plan of the profile whose work shape it
    // matches (see ORCHESTRATION_PLAN_ALIASES). What must hold is that a real
    // bundled plan resolved — never the TypeScript compatibility fallback —
    // and that the plan is either its own or its declared alias, so an
    // accidental alias to some unrelated profile still fails.
    assert.equal(defaults.planId, ORCHESTRATION_PLAN_ALIASES[profileId] ?? profileId);
    assert.deepEqual(manifest.orchestration, {
      mode: defaults.mode,
      availableRoles: defaults.availableRoles,
      disabledRoles: defaults.disabledRoles,
      maxParallel: defaults.maxParallel,
    });
  }
});

test('P23-8 custom setup is a valid primary-only plan that can be skipped or configured later', () => {
  const manifest = createWorkspaceManifest({ name: 'custom', profile: 'custom', by: 'wizard' });
  const preview = buildWorkspaceOnboardingPreview(manifest);

  assert.equal(preview.plan?.id, 'custom');
  assert.equal(preview.plan?.mode, 'off');
  assert.equal(preview.plan?.selectedStrategyId, 'direct');
  assert.deepEqual(preview.roles.effective, []);
  assert.deepEqual(
    preview.plan?.strategies[0]?.stages.map((stage) => [stage.id, stage.executorKind]),
    [['complete', 'primary']],
  );
});

test('P23-8 preview exposes only reviewed IDs, plan stages, concrete tool expansion, and ceilings', () => {
  const manifest = createWorkspaceManifest({ name: 'engineering', profile: 'engineering', by: 'wizard' });
  manifest.version = WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION;
  manifest.tools = {
    mode: 'explicit-catalog',
    profiles: ['coding'],
    enabled: ['web_search'],
    deny: ['run_command'],
  };
  const preview = buildWorkspaceOnboardingPreview(manifest);

  assert.equal(preview.plan?.id, 'engineering');
  assert.equal(preview.plan?.selectedStrategyId, 'direct');
  assert.deepEqual(preview.plan?.strategies[0]?.stages.map((stage) => stage.executorKind), ['primary']);
  assert.equal(preview.tools.mode, 'explicit-catalog');
  assert.equal(preview.tools.migrationRequired, false);
  assert.equal(preview.tools.effectiveToolIds.includes('read_file'), true);
  assert.equal(preview.tools.effectiveToolIds.includes('web_search'), true);
  assert.equal(preview.catalog.find((row) =>
    row.kind === 'tool-group' && row.id === 'coding')?.selected, true);
  assert.equal(preview.catalog.find((row) =>
    row.kind === 'tool' && row.id === 'web_search')?.selected, true);
  const frontend = preview.catalog.find((row) =>
    row.kind === 'capability' && row.id === 'frontend');
  assert.equal(frontend?.selected, true);
  assert.equal(frontend?.recommended, true);
  assert.equal(frontend?.selectable, true);
  assert.deepEqual(
    preview.catalog
      .filter((row) => row.kind === 'role' && row.selectable)
      .map((row) => row.id)
      .sort(),
    ['architect', 'explorer', 'reviewer', 'verifier', 'worker'],
  );
  const fleet = preview.catalog.find((row) => row.kind === 'role' && row.id === 'fleet');
  assert.equal(fleet?.selectable, false);
  assert.equal(fleet?.denied, true);
  assert.match(fleet?.blockedReason ?? '', /selected orchestration plan/);
  assert.equal(preview.ceilings.effectiveMaxParallel, 4);

  const previewKeys = new Set<string>();
  JSON.stringify(preview, (key, value) => {
    if (key) previewKeys.add(key);
    return value;
  });
  for (const unsafeKey of [
    'apiKey', 'credentials', 'rolePrompt', 'skillBody', 'absolutePath', 'mcpPayload',
  ]) {
    assert.equal(previewKeys.has(unsafeKey), false);
  }
});

test('P23-8 capability choices are profile-scoped while Custom remains explicit', () => {
  const research = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'research', profile: 'research', by: 'wizard' }),
  );
  const researchCapabilities = research.catalog.filter((row) => row.kind === 'capability');
  assert.deepEqual(
    researchCapabilities.filter((row) => row.selectable).map((row) => row.id),
    ['computational-research'],
  );
  assert.equal(researchCapabilities
    .filter((row) => !row.selectable)
    .every((row) =>
      row.blockedReason === 'Not contributed for the selected workspace profile.'), true);

  const dataScience = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'data', profile: 'data-science', by: 'wizard' }),
  );
  assert.deepEqual(
    dataScience.catalog
      .filter((row) => row.kind === 'capability' && row.selectable)
      .map((row) => row.id)
      .sort(),
    ['computational-research', 'data-visualization'],
  );

  const study = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' }),
  );
  assert.deepEqual(
    study.catalog
      .filter((row) => row.kind === 'capability' && row.selectable)
      .map((row) => row.id),
    ['programming-lab'],
  );

  const engineering = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'engineering', profile: 'engineering', by: 'wizard' }),
  );
  assert.deepEqual(
    engineering.catalog
      .filter((row) => row.kind === 'capability' && row.selectable)
      .map((row) => [row.id, row.recommended]),
    [
      ['backend', true],
      ['frontend', true],
      ['technical-documentation', false],
    ],
  );

  const writing = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'writing', profile: 'writing', by: 'wizard' }),
  );
  assert.deepEqual(
    writing.catalog
      .filter((row) => row.kind === 'capability' && row.selectable)
      .map((row) => row.id),
    ['academic-paper', 'technical-documentation'],
  );

  const custom = buildWorkspaceOnboardingPreview(
    createWorkspaceManifest({ name: 'custom', profile: 'custom', by: 'wizard' }),
  );
  assert.deepEqual(custom.catalog
    .filter((row) => row.kind === 'capability' && row.recommended)
    .map((row) => row.id), []);
  assert.deepEqual(
    custom.catalog
      .filter((row) => row.kind === 'capability' && row.selectable)
      .map((row) => row.id)
      .sort(),
    [
      'academic-paper',
      'backend',
      'computational-research',
      'data-visualization',
      'frontend',
      'programming-lab',
      'technical-documentation',
    ],
  );
});
