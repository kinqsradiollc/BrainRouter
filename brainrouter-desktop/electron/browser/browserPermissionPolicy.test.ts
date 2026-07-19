import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPermissionCheckScopes, browserPermissionRequestScope } from './browserPermissionPolicy.js';

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
