import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import { inspectWorkspaceProfilePlugins } from '../workspace/profilePlugins.js';
import { resolveWorkspaceSkillSelection } from '../workspace/skillSelection.js';

test('W4b no manifest preserves legacy skill discovery as an exact no-op', () => {
  assert.deepEqual(resolveWorkspaceSkillSelection({ manifest: null }), {
    managed: false,
    bundles: [],
    unavailable: [],
    skillRoots: [],
    ambientSkillIds: [],
    disabledSkillIds: [],
  });
});

test('W4b a profile pack selects its versioned standard-plugin root and skills', () => {
  const manifest = createWorkspaceManifest({ name: 'notes', profile: 'research', by: 'wizard' });
  const selection = resolveWorkspaceSkillSelection({ manifest });

  assert.equal(selection.managed, true);
  assert.deepEqual(selection.bundles.map(({ id, source, version }) => ({ id, source, version })), [
    { id: 'research', source: 'profile-plugin', version: '2.5.0' },
  ]);
  assert.equal(selection.skillRoots.length, 1);
  assert.deepEqual(selection.ambientSkillIds, [
    'planning-skill',
    'handover-skill',
    'research-question-skill',
    'source-strategy-skill',
    'iterative-evidence-skill',
    'evidence-research-skill',
    'claim-ledger-skill',
    'source-synthesis-skill',
    'citation-verification-skill',
    'research-review-skill',
    'academic-paper-drafting-skill',
    'academic-paper-review-skill',
  ]);
  assert.deepEqual(selection.unavailable, []);
});

test('W4b engineering keeps starter skills bundled and activates frontend only per task', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  const baseline = resolveWorkspaceSkillSelection({ manifest });

  assert.deepEqual(baseline.bundles.map((bundle) => bundle.id), ['engineering']);
  assert.equal(baseline.skillRoots.length, 0);
  assert.equal(baseline.ambientSkillIds.includes('taste-skill'), false);

  const frontend = resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] });
  assert.deepEqual(frontend.bundles.map(({ id, source }) => ({ id, source })), [
    { id: 'engineering', source: 'bundled' },
    { id: 'frontend', source: 'capability-plugin' },
  ]);
  assert.equal(frontend.skillRoots.length, 1);
  assert.ok(frontend.ambientSkillIds.includes('a11y-skill'));
  assert.ok(frontend.ambientSkillIds.includes('browser-testing-skill'));
  assert.ok(frontend.ambientSkillIds.includes('hallmark'), 'the one visual-craft skill rides the frontend capability');
  assert.equal(frontend.ambientSkillIds.includes('taste-skill'), false, 'ADR-056 D-B4: a world, not an ambient skill');
});

test('W4b backend skills activate only for the live task capability', () => {
  const manifest = createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' });
  const inactive = resolveWorkspaceSkillSelection({ manifest });
  assert.equal(inactive.bundles.some((bundle) => bundle.id === 'backend'), false);

  const active = resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['backend'] });
  assert.deepEqual(active.bundles.map(({ id, source }) => ({ id, source })), [
    { id: 'engineering', source: 'bundled' },
    { id: 'backend', source: 'capability-plugin' },
  ]);
  assert.ok(active.ambientSkillIds.includes('api-service-design-skill'));
  assert.ok(active.ambientSkillIds.includes('authorization-boundary-skill'));
  assert.ok(active.ambientSkillIds.includes('data-integrity-migration-skill'));
  assert.ok(active.ambientSkillIds.includes('background-work-skill'));
  assert.ok(active.ambientSkillIds.includes('production-readiness-skill'));
  assert.ok(active.ambientSkillIds.includes('backend-testing-skill'));
});

test('W4b a caller cannot activate a capability that the manifest disables or omits', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.capabilities.disabled.push('frontend');
  const disabled = resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] });
  assert.deepEqual(disabled.bundles.map((bundle) => bundle.id), ['engineering']);

  const research = createWorkspaceManifest({ name: 'notes', profile: 'research', by: 'wizard' });
  const absent = resolveWorkspaceSkillSelection({ manifest: research, activeCapabilities: ['frontend'] });
  assert.deepEqual(absent.bundles.map((bundle) => bundle.id), ['research']);
});

test('W4b static frontend pack text cannot bypass task-time capability activation', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.skills.packs.push('frontend');
  const selection = resolveWorkspaceSkillSelection({ manifest });

  assert.equal(selection.skillRoots.length, 0);
  assert.equal(selection.ambientSkillIds.includes('taste-skill'), false);
  assert.deepEqual(selection.unavailable, [{
    id: 'frontend',
    source: 'manifest-pack',
    reason: 'capability bundle requires task-time activation',
  }]);
});

test('W4b explicit skill disables win over profile and capability bundle contributions', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  manifest.skills.disabled.push('testing-skill', 'taste-skill');
  manifest.skills.enabled.push('taste-skill');
  const selection = resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] });

  assert.ok(!selection.ambientSkillIds.includes('testing-skill'));
  assert.ok(!selection.ambientSkillIds.includes('taste-skill'));
  assert.ok(selection.ambientSkillIds.includes('a11y-skill'));
  assert.deepEqual(selection.disabledSkillIds, ['testing-skill', 'taste-skill']);
});

test('W4b unknown and unavailable packs fail closed without hiding valid siblings', () => {
  const manifest = createWorkspaceManifest({ name: 'mixed', profile: 'research', by: 'wizard' });
  manifest.skills.packs.push('future-pack', 'writing');
  const catalog = inspectWorkspaceProfilePlugins();
  catalog.available = catalog.available.filter((plugin) => plugin.id !== 'research');
  catalog.unavailable.push({
    id: 'research',
    kind: 'profile',
    pluginName: 'profile-research',
    skillIds: [
      'research-question-skill',
      'source-strategy-skill',
      'iterative-evidence-skill',
      'evidence-research-skill',
      'claim-ledger-skill',
      'source-synthesis-skill',
      'citation-verification-skill',
      'research-review-skill',
      'academic-paper-drafting-skill',
      'academic-paper-review-skill',
    ],
    librarySkillIds: [],
    personaIds: ['researcher'],
    reason: 'fixture unavailable',
  });
  const selection = resolveWorkspaceSkillSelection({ manifest, catalog });

  assert.deepEqual(selection.bundles.map((bundle) => bundle.id), ['writing']);
  assert.deepEqual(selection.unavailable, [
    { id: 'research', source: 'manifest-pack', reason: 'fixture unavailable' },
    { id: 'future-pack', source: 'manifest-pack', reason: 'unknown skill pack' },
  ]);
  assert.ok(selection.ambientSkillIds.includes('structured-writing-skill'));
  assert.ok(!selection.ambientSkillIds.includes('evidence-research-skill'));
});

test('W4b resolution is deterministic, deduplicated, and does not mutate the manifest', () => {
  const manifest = createWorkspaceManifest({ name: 'study', profile: 'study', by: 'wizard' });
  manifest.skills.packs.push('study');
  manifest.skills.enabled.push('planning-skill');
  const before = structuredClone(manifest);
  const selection = resolveWorkspaceSkillSelection({ manifest });

  assert.deepEqual(manifest, before);
  assert.deepEqual(selection.bundles.map((bundle) => bundle.id), ['study']);
  assert.equal(selection.ambientSkillIds.length, new Set(selection.ambientSkillIds).size);
  assert.equal(selection.skillRoots.length, new Set(selection.skillRoots).size);
});
