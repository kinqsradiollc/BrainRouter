import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayKeyPair, decryptRelayPayload, encryptRelayPayload, hashDeviceToken, randomToken, tokenMatches } from './mobileRelayCrypto.js';
import { MobileDeviceRegistry } from './mobileDeviceRegistry.js';

test('NaCl relay boxes round-trip and reject the wrong key', () => {
  const desktop = createRelayKeyPair();
  const phone = createRelayKeyPair();
  const other = createRelayKeyPair();
  const envelope = encryptRelayPayload({ method: 'status.list', counter: 1 }, desktop.publicKey, phone.secretKey);
  assert.deepEqual(decryptRelayPayload(envelope, phone.publicKey, desktop.secretKey), { method: 'status.list', counter: 1 });
  assert.equal(decryptRelayPayload(envelope, other.publicKey, desktop.secretKey), null);
});

test('device tokens are stored and compared as constant-length hashes', () => {
  const token = randomToken();
  const hash = hashDeviceToken(token);
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(`${token}x`, hash), false);
  assert.doesNotMatch(hash, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('device registry is mode 0600 and never stores the plaintext token', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mobile-reg-'));
  const registry = new MobileDeviceRegistry(home);
  const token = randomToken();
  registry.put({ id: 'd1', name: 'Phone', publicKey: 'pub', tokenHash: hashDeviceToken(token), scopes: ['monitor'], lastCounter: 0, createdAt: new Date().toISOString() });
  const raw = fs.readFileSync(registry.file, 'utf8');
  assert.doesNotMatch(raw, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(registry.file).mode & 0o777, 0o600);
  fs.rmSync(home, { recursive: true, force: true });
});
