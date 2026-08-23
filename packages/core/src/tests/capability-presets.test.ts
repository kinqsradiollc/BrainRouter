// ADR-041 A41-9 — capability presets. The access tier a role grants is named once
// in a preset; roles consume presets. These assert the presets themselves and that
// every built-in role's derived access still matches its preset (byte-neutral).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_PRESETS, presetAccess, type CapabilityPreset } from '../orchestration/roles/capabilityPresets.js';
import { BUILT_IN_ROLES } from '../orchestration/roles/roles.js';

test('A41-9 — the four capability presets map to the expected access tiers', () => {
  assert.equal(CAPABILITY_PRESETS.readonly.access, 'read');
  assert.equal(CAPABILITY_PRESETS.implementer.access, 'write');
  assert.equal(CAPABILITY_PRESETS.executor.access, 'shell');
  assert.equal(CAPABILITY_PRESETS['sandboxed-executor'].access, 'shell');
  assert.equal(CAPABILITY_PRESETS['sandboxed-executor'].forceSandbox, true);
  // Only the fleet preset forces the sandbox.
  for (const [name, p] of Object.entries<CapabilityPreset>(CAPABILITY_PRESETS)) {
    if (name !== 'sandboxed-executor') assert.notEqual(p.forceSandbox, true, `${name} must not force the sandbox`);
  }
});

test('A41-9 — presetAccess only emits forceSandbox when the preset sets it', () => {
  assert.deepEqual(presetAccess('readonly'), { defaultAccess: 'read' });
  assert.deepEqual(presetAccess('implementer'), { defaultAccess: 'write' });
  assert.deepEqual(presetAccess('executor'), { defaultAccess: 'shell' });
  assert.deepEqual(presetAccess('sandboxed-executor'), { defaultAccess: 'shell', forceSandbox: true });
});

test('A41-9 — every built-in role that names a preset derives its access from it (byte-neutral)', () => {
  for (const role of Object.values(BUILT_IN_ROLES)) {
    if (!role.preset) continue;
    const derived = presetAccess(role.preset);
    assert.equal(role.defaultAccess, derived.defaultAccess, `${role.name} access matches its ${role.preset} preset`);
    assert.equal(role.forceSandbox ?? false, derived.forceSandbox ?? false, `${role.name} sandbox flag matches its preset`);
  }
});

test('A41-9 — the built-in roles consume the presets they should', () => {
  assert.equal(BUILT_IN_ROLES.explorer.preset, 'readonly');
  assert.equal(BUILT_IN_ROLES.architect.preset, 'readonly');
  assert.equal(BUILT_IN_ROLES.reviewer.preset, 'readonly');
  assert.equal(BUILT_IN_ROLES.intake.preset, 'readonly');
  assert.equal(BUILT_IN_ROLES.worker.preset, 'implementer');
  assert.equal(BUILT_IN_ROLES.verifier.preset, 'executor');
  assert.equal(BUILT_IN_ROLES.fleet.preset, 'sandboxed-executor');
});
