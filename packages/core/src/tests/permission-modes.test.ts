import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_MODES,
  getPermissionMode,
  policyForMode,
  nearestMode,
  type FriendlyPermissionMode,
} from '../session/preferences/permissionModes.js';

const ALL_IDS: FriendlyPermissionMode[] = ['read-only', 'workspace-write', 'ask-each', 'sensitive-ask', 'full-access'];

test('registry integrity: 5 unique ids, all covered, non-empty copy', () => {
  assert.equal(PERMISSION_MODES.length, 5);
  const ids = PERMISSION_MODES.map((m) => m.id);
  assert.equal(new Set(ids).size, 5, 'ids unique');
  assert.deepEqual([...ids].sort(), [...ALL_IDS].sort());
  for (const m of PERMISSION_MODES) {
    assert.ok(m.label.trim().length > 0, `${m.id} label`);
    assert.ok(m.description.trim().length > 0, `${m.id} description`);
  }
});

test('policyForMode returns the documented engine tuples', () => {
  assert.deepEqual(policyForMode('read-only'), {
    accessMode: 'read', executionMode: 'planning', reviewPolicy: 'request', sandbox: 'on', externalDirWrites: 'deny',
  });
  assert.deepEqual(policyForMode('full-access'), {
    accessMode: 'shell', executionMode: 'fast', reviewPolicy: 'proceed', sandbox: 'off', externalDirWrites: 'allow',
  });
  assert.equal(getPermissionMode('nope' as FriendlyPermissionMode), undefined);
  assert.equal(policyForMode('nope' as FriendlyPermissionMode), undefined);
});

test('round-trip: every mode is its own nearest match', () => {
  for (const id of ALL_IDS) {
    const policy = policyForMode(id)!;
    assert.equal(nearestMode(policy), id, `${id} should round-trip`);
  }
});

test('nearestMode: a partial tuple resolves to the closest mode', () => {
  // read access alone → read-only is the only read-tier mode
  assert.equal(nearestMode({ accessMode: 'read' }), 'read-only');
  // write access alone → workspace-write is the only write-tier mode
  assert.equal(nearestMode({ accessMode: 'write' }), 'workspace-write');
  // fast + proceed + allow → full-access
  assert.equal(nearestMode({ executionMode: 'fast', reviewPolicy: 'proceed', externalDirWrites: 'allow' }), 'full-access');
});

test('nearestMode: ties resolve to the more restrictive (earlier) mode', () => {
  // shell + planning matches both ask-each and (partly) others; the empty/ambiguous
  // input must never widen to full-access. With no fields at all, fall back to the
  // most restrictive mode.
  assert.equal(nearestMode({}), 'read-only');
  // shell-only is shared by ask-each/sensitive-ask/full-access (all shell); the
  // earliest (ask-each, the prompting one) wins the tie — never full-access.
  assert.equal(nearestMode({ accessMode: 'shell' }), 'ask-each');
});

test('every mode maps to a valid AccessMode and the sandbox/externalDir enums', () => {
  for (const m of PERMISSION_MODES) {
    assert.ok(['read', 'write', 'shell'].includes(m.policy.accessMode));
    assert.ok(['planning', 'fast'].includes(m.policy.executionMode));
    assert.ok(['request', 'proceed'].includes(m.policy.reviewPolicy));
    assert.ok(['off', 'on'].includes(m.policy.sandbox));
    assert.ok(['deny', 'ask', 'allow'].includes(m.policy.externalDirWrites));
  }
});
