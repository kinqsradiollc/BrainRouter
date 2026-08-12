/**
 * ADR-028 G3 — panel grouping.
 *
 * The grouping only earns its click if every panel lands somewhere sensible and
 * empty groups never appear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_DEFS, groupOf, panelsInGroup, activeGroups, PANEL_GROUPS, type PanelId } from './panelCatalog.js';

test('every registered panel has a group', () => {
  // An unmapped panel falls to Environment, which is a silent wrong answer
  // rather than a visible one — so assert the mapping is deliberate.
  const ungrouped = PANEL_DEFS
    .map((d) => d.id)
    .filter((id) => groupOf(id) === 'environment')
    .filter((id) => !['tools', 'servers', 'peers', 'browser', 'context', 'atlas', 'prototype'].includes(id));
  assert.deepEqual(ungrouped, [], `these panels fell to Environment by default: ${ungrouped.join(', ')}`);
});

test('the consolidated Pull request panel is Work, not Code', () => {
  // Deciding whether to land a change is work; reading the change is code.
  assert.equal(groupOf('stack'), 'work');
  assert.equal(groupOf('diff'), 'code');
});

test('comprehension is its own group — that is what makes room for it', () => {
  assert.equal(groupOf('comprehension'), 'understand');
});

test('an EMPTY group is never offered', () => {
  // A click that leads to a blank panel is worse than one fewer group.
  assert.deepEqual(activeGroups(['files', 'diff'] as PanelId[]), ['code']);
  assert.deepEqual(activeGroups([] as PanelId[]), []);
});

test('groups list the panels actually open, in catalog order', () => {
  const open = ['stack', 'files', 'plan'] as PanelId[];
  assert.deepEqual(panelsInGroup('work', open), ['stack', 'plan']);
  assert.deepEqual(panelsInGroup('code', open), ['files']);
  assert.deepEqual(panelsInGroup('knowledge', open), []);
});

test('every group has a label', () => {
  for (const [, label] of PANEL_GROUPS) assert.ok(label.length > 2);
});
