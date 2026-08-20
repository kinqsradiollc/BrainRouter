import assert from 'node:assert/strict';
import test from 'node:test';
import { MANUAL_PANEL_DEFS, PANEL_DEFS } from './Panel.js';

test('panel inventory has unique ids and exposes Project knowledge', () => {
  const ids = PANEL_DEFS.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    PANEL_DEFS.find((panel) => panel.id === 'knowledge'),
    // ADR-041 A41-7 — each panel row now carries its taxonomy `group` (folded in
    // from the former separate GROUP_OF map, so the two can no longer drift).
    { id: 'knowledge', title: 'Project knowledge', icon: 'brain', group: 'knowledge' },
  );
  assert.ok(MANUAL_PANEL_DEFS.some((panel) => panel.id === 'knowledge'));
});

test('internal detail panels remain hidden from the manual inventory', () => {
  const manualIds = new Set(MANUAL_PANEL_DEFS.map((panel) => panel.id));
  assert.equal(manualIds.has('file'), false);
  assert.equal(manualIds.has('task-detail'), false);
});
