/**
 * A40-1 — every workspace profile remains a complete reviewed-onboarding preset.
 *
 * Domain profile packs backed by the bundled skill library are declared in the
 * preset catalog rather than as physical profile plugins. This matrix exercises
 * the same Core validation/finalization primitives used by CLI and Desktop so a
 * new preset cannot silently ship an unknown pack on either host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import { buildWorkspaceOnboardingPreview } from '../workspace/onboardingPreview.js';
import { WORKSPACE_PROFILE_PLUGIN_DEFINITIONS } from '../workspace/profilePlugins.js';
import { WORKSPACE_PROFILES } from '../workspace/profiles.js';
import {
  buildWorkspaceSelectionCatalog,
  migrateWorkspaceManifestToolSelection,
  validateReviewedWorkspaceCapabilitySelection,
  validateReviewedWorkspacePersonaSelection,
  validateReviewedWorkspaceRoleSelection,
  validateReviewedWorkspaceSkillSelection,
} from '../workspace/selectionCatalog.js';
import {
  BUNDLED_WORKSPACE_SKILL_PACKS,
  resolveWorkspaceSkillSelection,
} from '../workspace/skillSelection.js';

test('A40-1 library-backed profile packs derive identity and skills from their owning presets', () => {
  const packagePackIds = new Set<string>(
    WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.map((definition) => definition.id),
  );
  const expected = WORKSPACE_PROFILES.flatMap((profile) =>
    profile.skills.packs
      .filter((id) => !packagePackIds.has(id))
      .map((id) => ({
        id,
        profileIds: [profile.id],
        skillIds: [],
      })));

  assert.deepEqual(
    BUNDLED_WORKSPACE_SKILL_PACKS.map((pack) => ({
      id: pack.id,
      profileIds: pack.profileIds,
      skillIds: pack.skillIds,
    })),
    expected,
  );
  assert.deepEqual(
    BUNDLED_WORKSPACE_SKILL_PACKS.map((pack) => pack.profileIds.length),
    BUNDLED_WORKSPACE_SKILL_PACKS.map(() => 1),
    'a profile-owned pack must not become a shared domain or plan alias',
  );
  assert.equal(
    BUNDLED_WORKSPACE_SKILL_PACKS.find((pack) => pack.id === 'engineering')?.description,
    'Bundled skills recommended for this workspace profile.',
    'the pre-A40-1 Engineering catalog copy remains stable',
  );
  assert.equal(Object.isFrozen(BUNDLED_WORKSPACE_SKILL_PACKS), true);
  assert.equal(BUNDLED_WORKSPACE_SKILL_PACKS.every((pack) => (
    Object.isFrozen(pack)
    && Object.isFrozen(pack.profileIds)
    && Object.isFrozen(pack.skillIds)
  )), true, 'profile-pack authority is immutable after derivation');
});

test('A40-1 all 17 untouched presets pass catalog selection and finalization', () => {
  const catalog = buildWorkspaceSelectionCatalog();

  for (const profile of WORKSPACE_PROFILES) {
    const manifest = createWorkspaceManifest({
      name: profile.id,
      profile: profile.id,
      by: 'wizard',
      at: '2026-08-13T00:00:00.000Z',
    });
    const before = structuredClone(manifest);
    const preview = buildWorkspaceOnboardingPreview(manifest, catalog);
    const fieldCatalog = { ...catalog, entries: preview.catalog };
    const reviews = {
      persona: validateReviewedWorkspacePersonaSelection(manifest.persona, catalog),
      roles: validateReviewedWorkspaceRoleSelection({
        availableRoles: manifest.orchestration.availableRoles,
        disabledRoles: manifest.orchestration.disabledRoles,
      }, fieldCatalog),
      capabilities: validateReviewedWorkspaceCapabilitySelection(
        manifest.capabilities,
        fieldCatalog,
      ),
      skills: validateReviewedWorkspaceSkillSelection(manifest.skills, catalog),
    };

    for (const [field, result] of Object.entries(reviews)) {
      assert.equal(
        result.ok,
        true,
        `${profile.id}/${field}: ${JSON.stringify(result)}`,
      );
    }

    const finalized = migrateWorkspaceManifestToolSelection({
      manifest,
      reviewed: {
        profiles: manifest.tools.profiles,
        enabled: manifest.tools.enabled ?? [],
        deny: manifest.tools.deny,
      },
      catalog,
      reviewedCatalogFingerprint: catalog.fingerprint,
    });
    const skillSelection = resolveWorkspaceSkillSelection({ manifest: finalized });

    assert.equal(finalized.version, 3, `${profile.id}: final manifest version`);
    assert.equal(finalized.profile, profile.id, `${profile.id}: profile identity`);
    assert.equal(preview.workspaceProfileId, profile.id, `${profile.id}: preview identity`);
    assert.ok(preview.plan, `${profile.id}: plan or declared alias must resolve`);
    assert.deepEqual(skillSelection.unavailable, [], `${profile.id}: unavailable packs`);
    assert.deepEqual(
      skillSelection.bundles.map((bundle) => bundle.id),
      manifest.skills.packs,
      `${profile.id}: selected profile pack`,
    );
    assert.deepEqual(manifest, before, `${profile.id}: finalization mutated its source`);
  }
});
