/**
 * ADR-034 private local registry and stable-device tests.
 *
 * Registry files contain a bearer token, so the permissions asserted here are
 * part of the transport's authorization boundary rather than cosmetic modes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  deriveLegacyRemoteDeviceId,
  getLocalMessagingDeviceId,
  getLocalMessagingRoot,
  getLocalSessionRegistryDirectory,
} from '../session/messaging/identity.js';
import {
  listLocalSessionRegistryEntries,
  newLocalSessionRegistryEntry,
  removeLocalSessionRegistryEntry,
  writeLocalSessionRegistryEntry,
} from '../session/messaging/registry.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('ADR-034 persists one device id and protects the registry from other users', async () => {
  await withTempWorkspaceAsync(async () => {
    const first = getLocalMessagingDeviceId();
    const second = getLocalMessagingDeviceId();
    assert.equal(second, first, 'a second process-facing read must retain the same machine identity');
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'first install creates a persisted random UUID rather than a path-derived id');

    const root = getLocalMessagingRoot();
    const registry = getLocalSessionRegistryDirectory();
    const deviceFile = path.join(root, 'device.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(deviceFile, 'utf8')), { version: 1, deviceId: first });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(root).mode & 0o777, 0o700);
      assert.equal(fs.statSync(registry).mode & 0o777, 0o700);
      assert.equal(fs.statSync(deviceFile).mode & 0o777, 0o600);
    }
  });
});

test('ADR-034 legacy remote identities are deterministic compatibility metadata', () => {
  const first = deriveLegacyRemoteDeviceId('legacy-session-key');
  assert.equal(deriveLegacyRemoteDeviceId('legacy-session-key'), first);
  assert.notEqual(deriveLegacyRemoteDeviceId('another-session-key'), first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('ADR-034 registry filenames never contain session keys and cleanup owns one listener instance', async () => {
  await withTempWorkspaceAsync(async () => {
    const now = 1_700_000_000_000;
    const entry = newLocalSessionRegistryEntry({
      sessionKey: 'desktop:workspace/secret-looking-key',
      deviceId: getLocalMessagingDeviceId(),
      clientKind: 'desktop',
      state: 'working',
      pid: process.pid,
      port: 31_337,
      registeredAt: now,
      updatedAt: now,
      title: 'Readable title',
    });
    writeLocalSessionRegistryEntry(entry);

    const files = fs.readdirSync(getLocalSessionRegistryDirectory());
    assert.equal(files.length, 1);
    assert.doesNotMatch(files[0]!, /desktop|workspace|secret-looking-key/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(getLocalSessionRegistryDirectory(), files[0]!)).mode & 0o777, 0o600);
    }
    assert.deepEqual(listLocalSessionRegistryEntries(), [entry]);
    assert.equal(removeLocalSessionRegistryEntry({ ...entry, token: '0'.repeat(64) }), false,
      'a stale or forged owner must not remove the live entry');
    assert.equal(removeLocalSessionRegistryEntry(entry), true);
    assert.deepEqual(listLocalSessionRegistryEntries(), []);
  });
});

test('ADR-034 malformed-entry reaping preserves a concurrently committed valid inode', async (context) => {
  await withTempWorkspaceAsync(async () => {
    const now = 1_700_000_000_000;
    const entry = newLocalSessionRegistryEntry({
      sessionKey: 'session:registry-replacement-race',
      deviceId: getLocalMessagingDeviceId(),
      clientKind: 'cli',
      state: 'idle',
      pid: process.pid,
      port: 31_338,
      registeredAt: now,
      updatedAt: now,
      title: 'Old registry value',
    });
    writeLocalSessionRegistryEntry(entry);
    const registry = getLocalSessionRegistryDirectory();
    const filePath = path.join(registry, fs.readdirSync(registry)[0]!);
    fs.writeFileSync(filePath, '{malformed', { encoding: 'utf8', mode: 0o600 });

    const replacement = {
      ...entry,
      state: 'working' as const,
      title: 'Concurrent valid replacement',
      updatedAt: now + 1,
    };
    const originalRename = fs.renameSync;
    let replacementInode: number | undefined;
    let injected = false;
    context.mock.method(fs, 'renameSync', ((source: fs.PathLike, destination: fs.PathLike) => {
      if (!injected && String(destination).endsWith('.reap')) {
        injected = true;
        const staged = path.join(registry, '.race-valid.tmp');
        fs.writeFileSync(staged, `${JSON.stringify(replacement, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        originalRename(staged, source);
        replacementInode = fs.statSync(source).ino;
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);

    assert.deepEqual(listLocalSessionRegistryEntries(), [replacement]);
    assert.equal(injected, true, 'the test must replace the inode at the cleanup race seam');
    assert.equal(fs.statSync(filePath).ino, replacementInode,
      'cleanup must restore the exact valid inode rather than deleting it by stale pathname');
    assert.deepEqual(fs.readdirSync(registry).filter((name) => name.endsWith('.reap')), []);
  });
});

test('ADR-034 refuses a corrupt persisted identity instead of silently changing devices', async () => {
  await withTempWorkspaceAsync(async () => {
    const root = getLocalMessagingRoot();
    fs.writeFileSync(path.join(root, 'device.json'), '{"version":1,"deviceId":"different every boot"}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    assert.throws(() => getLocalMessagingDeviceId(), /identity is invalid/);
  });
});
