import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogRowsForField } from './OnboardingCatalogFields.js';
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
