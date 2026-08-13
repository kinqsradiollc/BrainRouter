/**
 * ADR-040 A40-1 orchestration-plan identity policy tests.
 *
 * Workspace identity owns domain authority while plan identity may name one
 * reviewed bundled work shape. Exact claims retain source precedence; aliases
 * never inherit a workspace or plugin override at their target ID.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  findBundledOrchestrationProfile,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import type {
  OrchestrationProfileDefinition,
} from '../orchestration/profiles/orchestrationProfileDefinitionFile.js';
import type {
  ResolvedOrchestrationProfileCatalog,
  ResolvedOrchestrationProfileEntry,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import {
  resolveOrchestrationPlanIdentity,
} from '../workspace/orchestrationPlanIdentity.js';
import {
  resolveActiveTurnOrchestration,
} from '../workspace/activeTurnOrchestration.js';
import { buildWorkspaceOnboardingPreview } from '../workspace/onboardingPreview.js';
import { buildWorkspaceOnboardingSources } from '../workspace/onboardingSources.js';
import {
  createWorkspaceManifest,
  saveWorkspaceManifest,
} from '../workspace/manifest.js';
import { withTempWorkspace } from './_helpers.js';

function bundled(id: string): OrchestrationProfileDefinition {
  const definition = findBundledOrchestrationProfile(id);
  assert.ok(definition, `missing bundled ${id} fixture`);
  return definition;
}

function entry(
  definition: OrchestrationProfileDefinition,
  kind: 'workspace-local' | 'workspace' | 'plugin' | 'bundled' = 'workspace-local',
): ResolvedOrchestrationProfileEntry {
  return {
    id: definition.id,
    definition,
    source: { kind, provenance: kind },
  };
}

function catalog(input: {
  entries?: ResolvedOrchestrationProfileEntry[];
  unavailableIds?: string[];
} = {}): ResolvedOrchestrationProfileCatalog {
  return {
    entries: new Map((input.entries ?? []).map((item) => [item.id, item])),
    unavailableIds: new Set(input.unavailableIds ?? []),
    diagnostics: [],
  };
}

test('ADR-040 A40-1 a valid exact plan outranks the declared bundled alias', () => {
  const exact = structuredClone(bundled('engineering'));
  exact.id = 'product-management';
  exact.displayName = 'Reviewed product plan';

  const resolved = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog({ entries: [entry(exact)] }),
  });

  assert.equal(resolved.resolution, 'exact');
  assert.equal(resolved.workspaceProfileId, 'product-management');
  assert.equal(resolved.planProfileId, 'product-management');
  assert.equal(resolved.definition, exact);
  assert.equal(resolved.source?.kind, 'workspace-local');
});

test('ADR-040 A40-1 an invalid exact claim fails closed instead of using its alias', () => {
  const resolved = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog({ unavailableIds: ['product-management'] }),
  });

  assert.equal(resolved.resolution, 'exact-unavailable');
  assert.equal(resolved.workspaceProfileId, 'product-management');
  assert.equal(resolved.planProfileId, null);
  assert.equal(resolved.definition, undefined);
  assert.equal(resolved.source, undefined);
});

test('ADR-040 A40-1 a malformed exact catalog entry cannot manufacture an alias', () => {
  const malformed = entry(bundled('engineering'));
  const resolved = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog({
      entries: [{ ...malformed, id: 'product-management' }],
    }),
  });

  assert.equal(resolved.resolution, 'exact-unavailable');
  assert.equal(resolved.workspaceProfileId, 'product-management');
  assert.equal(resolved.planProfileId, null);
  assert.equal(resolved.definition, undefined);
});

test('ADR-040 A40-1 a declared alias uses bundled data, not an alias-target override', () => {
  const targetOverride = structuredClone(bundled('engineering'));
  targetOverride.displayName = 'Untrusted alias-target replacement';

  const resolved = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog({ entries: [entry(targetOverride, 'plugin')] }),
  });

  assert.equal(resolved.resolution, 'bundled-alias');
  assert.equal(resolved.workspaceProfileId, 'product-management');
  assert.equal(resolved.planProfileId, 'engineering');
  assert.equal(resolved.definition?.displayName, 'Engineering orchestration');
  assert.notEqual(resolved.definition, targetOverride);
  assert.deepEqual(resolved.source, { kind: 'bundled', provenance: 'bundled' });
});

test('ADR-040 A40-1 missing or malformed bundled alias data falls back directly', () => {
  const missing = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog(),
    findBundledPlan: () => undefined,
  });
  assert.equal(missing.resolution, 'no-plan');
  assert.equal(missing.planProfileId, null);

  const wrongId = structuredClone(bundled('research'));
  const malformed = resolveOrchestrationPlanIdentity('product-management', {
    catalog: catalog(),
    findBundledPlan: () => wrongId,
  });
  assert.equal(malformed.resolution, 'exact-unavailable');
  assert.equal(malformed.planProfileId, null);
});

test('ADR-040 A40-1 onboarding and active turns fail closed on an invalid exact alias claim', () => {
  withTempWorkspace((workspace) => {
    writeWorkspacePlan(workspace, 'product-management', '{}');
    const manifest = createWorkspaceManifest({
      name: 'product',
      profile: 'product-management',
      by: 'wizard',
    });
    const sources = buildWorkspaceOnboardingSources(workspace);
    assert.equal(sources.orchestrationProfiles.unavailableIds.has('product-management'), true);

    const preview = buildWorkspaceOnboardingPreview(
      manifest,
      sources.catalog,
      sources.orchestrationProfiles,
    );
    assert.equal(preview.workspaceProfileId, 'product-management');
    assert.equal(preview.planProfileId, null);
    assert.equal(preview.plan, null, 'onboarding must not hide the invalid exact claim with an alias');

    saveWorkspaceManifest(workspace, manifest);
    const active = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Hello, how are you?',
    });
    assert.equal(active.source, 'unavailable');
    assert.equal(active.plan.workspaceProfileId, 'product-management');
    assert.equal(active.plan.planProfileId, null);
    assert.equal(active.plan.orchestrationProfileId, null);
    assert.equal(active.plan.strategyId, null);
    assert.equal(active.plan.diagnostics[0]?.code, 'no-plan');
  });
});

test('ADR-040 A40-1 onboarding and active turns prefer a valid exact plan over its alias', () => {
  withTempWorkspace((workspace) => {
    const exact = structuredClone(bundled('engineering'));
    exact.id = 'product-management';
    exact.displayName = 'Reviewed product orchestration';
    writeWorkspacePlan(workspace, exact.id, JSON.stringify(exact));
    const manifest = createWorkspaceManifest({
      name: 'product',
      profile: 'product-management',
      by: 'wizard',
    });
    const sources = buildWorkspaceOnboardingSources(workspace);

    const preview = buildWorkspaceOnboardingPreview(
      manifest,
      sources.catalog,
      sources.orchestrationProfiles,
    );
    assert.equal(preview.planProfileId, 'product-management');
    assert.equal(preview.plan?.displayName, 'Reviewed product orchestration');
    assert.equal(preview.plan?.source.kind, 'workspace-local');

    saveWorkspaceManifest(workspace, manifest);
    const active = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Hello, how are you?',
    });
    assert.equal(active.source, 'workspace-local');
    assert.equal(active.plan.workspaceProfileId, 'product-management');
    assert.equal(active.plan.planProfileId, 'product-management');
    assert.equal(active.plan.orchestrationProfileId, 'product-management');
    assert.equal(active.plan.strategyId, 'direct');
  });
});

test('ADR-040 A40-1 onboarding review fingerprint changes for a compatible exact replacement', () => {
  withTempWorkspace((workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'campaign',
      profile: 'marketing',
      by: 'wizard',
    });
    const reviewedSources = buildWorkspaceOnboardingSources(workspace);
    const reviewedPreview = buildWorkspaceOnboardingPreview(
      manifest,
      reviewedSources.catalog,
      reviewedSources.orchestrationProfiles,
    );

    const exact = structuredClone(bundled('writing'));
    exact.id = 'marketing';
    exact.displayName = 'Workspace marketing orchestration';
    writeWorkspacePlan(workspace, exact.id, JSON.stringify(exact));

    const currentSources = buildWorkspaceOnboardingSources(workspace);
    const currentPreview = buildWorkspaceOnboardingPreview(
      manifest,
      currentSources.catalog,
      currentSources.orchestrationProfiles,
    );
    assert.equal(
      currentSources.catalog.fingerprint,
      reviewedSources.catalog.fingerprint,
      'selection catalog metadata did not change',
    );
    assert.equal(reviewedPreview.planProfileId, 'writing');
    assert.equal(currentPreview.planProfileId, 'marketing');
    assert.notEqual(currentPreview.catalogFingerprint, reviewedPreview.catalogFingerprint);
  });
});

function writeWorkspacePlan(
  workspace: string,
  id: string,
  contents: string,
): void {
  const directory = path.join(workspace, '.brainrouter', 'orchestration-profiles');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.json`), contents);
}
