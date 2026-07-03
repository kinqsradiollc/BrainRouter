import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_ROLES } from '../orchestration/registry/roles.js';

// A3 — the worker overlay must forbid faking work with tool-call-shaped TEXT
// (the NotionApp2 minimax worker emitted 24 such wrappers and did 0 real edits).
test('worker overlay enforces real tool calls (A3 completion contract)', () => {
  const overlay = BUILT_IN_ROLES.worker.promptOverlay;
  assert.match(overlay, /Real tool calls only/i);
  assert.match(overlay, /not executed/i, 'must warn that tool-call markup as text does nothing');
  assert.match(overlay, /## Files changed/, 'must require a Files changed completion block');
});
