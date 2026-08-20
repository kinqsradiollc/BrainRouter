// ADR-041 A41-12 — service profiles + typed remote binding. Assert the provider
// gateway is registered as a service profile and that the remote-binding gate is a
// boot error for anything not remote-capable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_PROFILES,
  resolveServiceProfile,
  serviceProfileIds,
  assertRemoteBindable,
  RemoteBindingUnsupportedError,
} from '../runtime/serviceProfiles.js';

test('A41-12 — the provider gateway is registered as a service profile', () => {
  assert.ok(serviceProfileIds().includes('provider-gateway'));
  const gw = resolveServiceProfile('provider-gateway');
  assert.equal(gw?.transport, 'http');
  assert.equal(gw?.remoteCapable, true, 'the gateway seam is remote-bindable (ADR-043)');
  assert.ok((gw?.defaultPort ?? 0) > 0);
});

test('A41-12 — every profile is keyed by its own id and well-formed', () => {
  for (const id of serviceProfileIds()) {
    const svc = SERVICE_PROFILES[id as keyof typeof SERVICE_PROFILES];
    assert.equal(svc.id, id);
    assert.ok(svc.description.length > 10);
    assert.equal(typeof svc.remoteCapable, 'boolean');
  }
});

test('A41-12 — assertRemoteBindable returns the profile for a remote-capable service', () => {
  const svc = assertRemoteBindable('provider-gateway');
  assert.equal(svc.id, 'provider-gateway');
});

test('A41-12 — assertRemoteBindable is a boot error for an unknown service', () => {
  assert.throws(() => assertRemoteBindable('does-not-exist'), RemoteBindingUnsupportedError);
});
