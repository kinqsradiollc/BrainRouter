/**
 * P23-16 — view recommendation grouping stays advisory, complete, and
 * profile-aware without changing panel authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_PANEL_DEFS } from '../../panels/panelCatalog.js';
import {
  groupWorkspaceViews,
  workspaceViewContextFromManifest,
} from './viewRecommendations.js';

test('P23-16 Research suggestions prioritize evidence surfaces and preserve every view', () => {
  const grouped = groupWorkspaceViews({ profileId: 'research', capabilityIds: [] }, ['knowledge', 'browser']);
  assert.deepEqual(grouped.active.map((panel) => panel.id), ['knowledge', 'browser']);
  assert.ok(grouped.suggested.some((panel) => panel.id === 'annotations'));
  assert.ok(grouped.more.some((panel) => panel.id === 'servers'));
  assert.deepEqual(
    new Set([...grouped.active, ...grouped.suggested, ...grouped.more].map((panel) => panel.id)),
    new Set(MANUAL_PANEL_DEFS.map((panel) => panel.id)),
  );
});

test('P23-16 Engineering capabilities add relevant views without hiding the rest', () => {
  const grouped = groupWorkspaceViews(
    { profileId: 'engineering', capabilityIds: ['frontend', 'backend'] },
    ['files'],
  );
  assert.deepEqual(grouped.active.map((panel) => panel.id), ['files']);
  for (const id of ['browser', 'prototype', 'servers']) {
    assert.ok(grouped.suggested.some((panel) => panel.id === id));
  }
  assert.ok(grouped.more.some((panel) => panel.id === 'annotations'));
});

test('P23-16 manifest parsing fails closed to Custom recommendations', () => {
  assert.deepEqual(workspaceViewContextFromManifest(null), {
    profileId: 'custom',
    capabilityIds: [],
  });
  assert.deepEqual(workspaceViewContextFromManifest({
    profile: 'research',
    capabilities: { enabled: ['frontend', 7, null] },
  }), {
    profileId: 'research',
    capabilityIds: ['frontend'],
  });
});
