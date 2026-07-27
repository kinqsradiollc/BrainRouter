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
    assert.equal(defaults.planId, profileId);
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
  assert.equal(researchCapabilities.every((row) => !row.selectable), true);
  assert.equal(researchCapabilities.every((row) =>
    row.blockedReason === 'Not contributed for the selected workspace profile.'), true);

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
    ['backend', 'frontend'],
  );
});
