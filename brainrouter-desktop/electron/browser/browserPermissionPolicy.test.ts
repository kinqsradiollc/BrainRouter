import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPermissionCheckScopes, browserPermissionRequestScope, isPersistableBrowserPermission, browserPermissionGrantsFor } from './browserPermissionPolicy.js';

test('media grants stay scoped to the requested device category', () => {
  assert.deepEqual(browserPermissionRequestScope('media', ['audio']), { promptPermission: 'microphone', grants: ['media:audio'] });
  assert.deepEqual(browserPermissionCheckScopes('media', 'audio'), ['media:audio']);
  assert.deepEqual(browserPermissionCheckScopes('media', 'video'), ['media:video']);
  assert.notDeepEqual(browserPermissionCheckScopes('media', 'video'), browserPermissionRequestScope('media', ['audio'])?.grants);
  assert.deepEqual(browserPermissionRequestScope('media', ['video', 'audio']), {
    promptPermission: 'microphone+camera', grants: ['media:audio', 'media:video'],
  });
});

test('unknown and high-risk permissions fail closed', () => {
  for (const permission of ['display-capture', 'midiSysex', 'openExternal', 'fileSystem', 'serial', 'hid', 'usb', 'unknown']) {
    assert.equal(browserPermissionRequestScope(permission), null, permission);
    assert.deepEqual(browserPermissionCheckScopes(permission), [], permission);
  }
  assert.equal(browserPermissionRequestScope('media', []), null);
  assert.deepEqual(browserPermissionRequestScope('geolocation'), { promptPermission: 'geolocation', grants: ['geolocation'] });
});

// ADR-055 P10 — per-site permission memory covers every promptable permission.
test('P10 persistable permissions + their real grants', () => {
  for (const p of ['geolocation', 'notifications', 'fullscreen', 'idle-detection', 'pointerLock', 'microphone', 'camera', 'microphone+camera']) {
    assert.equal(isPersistableBrowserPermission(p), true, p);
  }
  // Unknown / unsupported permissions are never persisted.
  for (const p of ['midi', 'usb', 'serial', 'openExternal', '', 'media']) {
    assert.equal(isPersistableBrowserPermission(p), false, p);
  }
  // A remembered media decision restores the grants Chromium actually checks.
  assert.deepEqual(browserPermissionGrantsFor('camera'), ['media:video']);
  assert.deepEqual(browserPermissionGrantsFor('microphone'), ['media:audio']);
  assert.deepEqual(browserPermissionGrantsFor('microphone+camera'), ['media:audio', 'media:video']);
  assert.deepEqual(browserPermissionGrantsFor('geolocation'), ['geolocation']);
  assert.deepEqual(browserPermissionGrantsFor('usb'), []);
});
