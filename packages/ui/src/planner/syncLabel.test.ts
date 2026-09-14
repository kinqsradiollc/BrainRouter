/**
 * ADR-038 D4 — the sync control says WHY changes are not moving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBlockerShort, syncLabel } from './PlannerSurface.js';

test('with a blocker and queued changes the label names the reason; without, the host label stands', () => {
  const base = { label: '21 changes waiting to sync.', pendingCount: 21, issues: [] };
  assert.equal(syncLabel({ ...base, blocker: { kind: 'unreachable', message: 'The server at http://localhost:3747 is not answering.' } }), '21 changes waiting — server unreachable.');
  assert.equal(syncLabel({ ...base, blocker: { kind: 'sign-in', message: 'Sign in.' } }), '21 changes waiting — sign in to sync.');
  assert.equal(syncLabel({ ...base, pendingCount: 1, blocker: { kind: 'organization', message: 'Choose.' } }), '1 change waiting — choose an organization.');
  assert.equal(syncLabel({ ...base, blocker: { kind: 'local-only', message: 'No server.' } }), '21 changes waiting — no server configured.');
  assert.equal(syncLabel(base), '21 changes waiting to sync.');
  assert.equal(syncLabel({ label: 'Everything is synced.', pendingCount: 0, issues: [], blocker: { kind: 'unreachable', message: 'x' } }), 'Everything is synced.', 'nothing queued: no reason to alarm');
  assert.equal(syncBlockerShort('error'), 'sync failed');
});
