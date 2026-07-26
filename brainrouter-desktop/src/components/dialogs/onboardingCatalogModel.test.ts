import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboardingPreview } from './onboardingCatalogModel.js';

const digest = 'd'.repeat(64);

function preview(): Record<string, unknown> {
  return {
    profileId: 'custom',
    catalogFingerprint: digest,
    catalog: [{
      id: 'worker',
      kind: 'role',
      label: 'Worker',
      description: 'Produces one bounded artifact or change.',
      source: 'bundled',
      provenance: 'bundled-roles',
      persistable: true,
      selectable: true,
      selected: true,
      recommended: true,
      denied: false,
    }, {
      id: 'coding',
      kind: 'tool-group',
      label: 'Files and code',
      description: 'Inspect and edit code.',
      source: 'core',
      provenance: 'workspace-tool-groups',
      persistable: true,
      selectable: true,
      expandsTo: ['read_file', 'apply_patch'],
      selected: false,
      recommended: false,
      denied: false,
    }],
    plan: {
      id: 'custom',
      displayName: 'Custom orchestration',
      mode: 'off',
      selectedStrategyId: 'direct',
      source: { kind: 'bundled', provenance: 'bundled' },
      strategies: [{
        id: 'direct',
        description: 'Complete directly.',
        stages: [{
          id: 'complete',
          executorKind: 'primary',
          skillIds: [],
          optional: false,
          maxChildren: 0,
        }],
      }],
    },
    roles: { effective: [] },
    skills: { effective: [] },
    tools: { effectiveToolIds: [], effectiveExtensionIds: [], deniedIds: [] },
    ceilings: { planMaxParallel: 1, manifestMaxParallel: 1, effectiveMaxParallel: 1 },
  };
}

test('parses safe catalog metadata and primary-only Custom preview', () => {
  const parsed = parseOnboardingPreview(preview());
  assert.ok(parsed);
  assert.equal(parsed.plan?.selectedStrategyId, 'direct');
  assert.deepEqual(parsed.plan?.source, { kind: 'bundled', provenance: 'bundled' });
  assert.deepEqual(parsed.plan?.strategies[0]?.stages, [{
    id: 'complete',
    executorKind: 'primary',
    skillIds: [],
    optional: false,
    maxChildren: 0,
  }]);
  assert.equal(parsed.catalog[0]?.kind, 'role');
  assert.deepEqual(parsed.catalog[1]?.expandsTo, ['read_file', 'apply_patch']);
});

test('rejects malformed fingerprints, oversized catalogs, and executable-looking catalog data', () => {
  assert.equal(parseOnboardingPreview({ ...preview(), catalogFingerprint: 'stale' }), null);
  assert.equal(parseOnboardingPreview({
    ...preview(),
    catalog: Array.from({ length: 513 }, () => (preview().catalog as unknown[])[0]),
  }), null);
  const unsafe = preview();
  unsafe.catalog = [{
    ...(unsafe.catalog as Array<Record<string, unknown>>)[0],
    selectable: 'yes',
  }];
  assert.equal(parseOnboardingPreview(unsafe), null);
});
