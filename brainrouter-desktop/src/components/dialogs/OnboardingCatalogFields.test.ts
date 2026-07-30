import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogRowsForField,
  recommendedAdditionCount,
  recommendedAdditionValues,
} from './OnboardingCatalogFields.js';
import type { OnboardingCatalogRow } from './onboardingCatalogModel.js';

function row(overrides: Partial<OnboardingCatalogRow>): OnboardingCatalogRow {
  return {
    id: 'research',
    kind: 'skill-pack',
    label: 'Research',
    description: 'Included profile workflows.',
    source: 'profile-plugin',
    provenance: 'profile-research',
    persistable: true,
    selectable: true,
    expandsTo: [],
    selected: true,
    recommended: true,
    denied: false,
    ...overrides,
  };
}

test('additional skill-pack choices exclude the included profile and capability-owned packs', () => {
  const rows = catalogRowsForField({
    catalog: [
      row({ id: 'research' }),
      row({ id: 'frontend', managedByCapability: 'frontend' }),
      row({ id: 'writing', label: 'Writing', selected: false, recommended: false }),
    ],
    kinds: ['skill-pack'],
    values: ['research'],
    excludedIds: ['research'],
  });

  assert.deepEqual(rows.map((entry) => entry.id), ['writing']);
});

test('existing workspaces expose selectable unselected recommendations as additions', () => {
  const rows = [
    row({
      id: 'workspace-files',
      kind: 'tool-group',
      label: 'Workspace files',
      selected: false,
      recommended: true,
    }),
    row({
      id: 'artifacts',
      kind: 'tool-group',
      label: 'Artifacts',
      selected: true,
      recommended: true,
    }),
    row({
      id: 'interactive-browser',
      kind: 'tool-group',
      label: 'Interactive browser',
      selected: false,
      recommended: false,
    }),
    row({
      id: 'blocked',
      kind: 'tool-group',
      label: 'Blocked',
      selected: false,
      recommended: true,
      selectable: false,
    }),
  ];

  assert.equal(recommendedAdditionCount(rows, ['artifacts']), 1);
  assert.deepEqual(
    recommendedAdditionValues(rows, ['artifacts']),
    ['workspace-files'],
    'the apply action receives only selectable, non-denied missing recommendations',
  );
  assert.equal(
    recommendedAdditionCount(rows, ['workspace-files', 'artifacts']),
    0,
  );
  assert.equal(
    recommendedAdditionCount(rows, ['artifacts'], false),
    0,
    'deny and disable selectors never recommend removing a grant',
  );
});

test('recommendation count remains independent from the visible search filter', () => {
  const rows = [
    row({
      id: 'workspace-files',
      kind: 'tool-group',
      label: 'Workspace files',
      selected: false,
      recommended: true,
    }),
    row({
      id: 'artifacts',
      kind: 'tool-group',
      label: 'Artifacts',
      selected: false,
      recommended: true,
    }),
  ];
  const visible = catalogRowsForField({
    catalog: rows,
    kinds: ['tool-group'],
    values: [],
    query: 'workspace',
  });

  assert.deepEqual(visible.map((entry) => entry.id), ['workspace-files']);
  assert.equal(recommendedAdditionCount(rows, []), 2);
});
