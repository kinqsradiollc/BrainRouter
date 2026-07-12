import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDE_RAIL_MAX,
  SIDE_RAIL_MIN,
  clampSideRailWidth,
  openWidthFor,
  reorderByValue,
  sideRailClassName,
  sideRailFullscreenTitle,
} from './sideRailLayout.js';

test('clampSideRailWidth keeps the rail within its normal drag bounds', () => {
  assert.equal(clampSideRailWidth(120), SIDE_RAIL_MIN);
  assert.equal(clampSideRailWidth(500), 500);
  assert.equal(clampSideRailWidth(9999), SIDE_RAIL_MAX);
  assert.equal(clampSideRailWidth(Number.NaN), 330);
});

test('sideRailClassName includes closing and fullscreen states', () => {
  assert.equal(sideRailClassName(false, false), 'views-rail');
  assert.equal(sideRailClassName(true, false), 'views-rail closing');
  assert.equal(sideRailClassName(false, true), 'views-rail fullscreen');
  assert.equal(sideRailClassName(true, true), 'views-rail closing fullscreen');
});

test('sideRailFullscreenTitle describes the next action', () => {
  assert.equal(sideRailFullscreenTitle(false), 'Enlarge panel');
  assert.equal(sideRailFullscreenTitle(true), 'Restore panel width');
});

test('reorderByValue moves an item before the drop target without mutating', () => {
  const tabs = ['diff', 'files', 'editor', 'plan'];
  const next = reorderByValue(tabs, 'plan', 'files');
  assert.deepEqual(next, ['diff', 'plan', 'files', 'editor']);
  assert.deepEqual(tabs, ['diff', 'files', 'editor', 'plan']);
});

test('reorderByValue moves a forward-dragged item before the drop target', () => {
  const tabs = ['diff', 'files', 'editor', 'plan'];
  assert.deepEqual(reorderByValue(tabs, 'files', 'plan'), ['diff', 'editor', 'files', 'plan']);
});

test('reorderByValue is stable for no-op and unknown values', () => {
  const tabs = ['diff', 'files', 'editor'];
  assert.equal(reorderByValue(tabs, 'files', 'files'), tabs);
  assert.equal(reorderByValue(tabs, 'missing', 'files'), tabs);
  assert.equal(reorderByValue(tabs, 'files', 'missing'), tabs);
});

test('openWidthFor widens to the Browser comfortable width, never shrinks', () => {
  assert.equal(openWidthFor('uitest', SIDE_RAIL_MIN), 500); // 240 -> 500 on open
  assert.equal(openWidthFor('uitest', 640), 640);           // already wider: unchanged
  assert.equal(openWidthFor('uitest', 500), 500);           // exactly at the default
});

test('openWidthFor leaves a rail already at max, and never widens a panel with no preference', () => {
  // already at (or above) the rail max: widen is a no-op, and the clamped
  // preference (≤ max) never over-widens past the current width.
  assert.equal(openWidthFor('uitest', SIDE_RAIL_MAX), SIDE_RAIL_MAX);
  assert.equal(openWidthFor('uitest', SIDE_RAIL_MAX + 500), SIDE_RAIL_MAX + 500);
  // a panel without an OPEN_WIDTH preference keeps whatever width it had.
  assert.equal(openWidthFor('files', 300), 300);
  assert.equal(openWidthFor('files', SIDE_RAIL_MIN), SIDE_RAIL_MIN);
});

test('openWidthFor leaves panels without a preferred width untouched', () => {
  assert.equal(openWidthFor('files', SIDE_RAIL_MIN), SIDE_RAIL_MIN);
  assert.equal(openWidthFor('atlas', 300), 300);
  assert.equal(openWidthFor('editor', 720), 720);
});
