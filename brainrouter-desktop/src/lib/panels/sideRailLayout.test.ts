import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDE_RAIL_MAX,
  SIDE_RAIL_MIN,
  clampSideRailWidth,
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
