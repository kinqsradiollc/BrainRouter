import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceKeyPair, decryptPayload, encryptPayload } from './crypto';
import { parsePairingPayload } from './types';

test('mobile crypto boxes round-trip and reject another device', () => {
  const server = createDeviceKeyPair();
  const device = createDeviceKeyPair();
  const other = createDeviceKeyPair();
  const encrypted = encryptPayload({ hello: 'mobile' }, server.publicKey, device.secretKey);
  assert.deepEqual(decryptPayload(encrypted, device.publicKey, server.secretKey), { hello: 'mobile' });
  assert.equal(decryptPayload(encrypted, other.publicKey, server.secretKey), null);
});

test('pairing accepts only unexpired private-network WebSocket endpoints', () => {
  const valid = parsePairingPayload(JSON.stringify({
    version: 1, endpoints: ['ws://100.70.1.2:4400', 'ws://192.168.1.8:4400', 'ws://8.8.8.8:4400'],
    serverPublicKey: 'pub', pairingToken: 'once', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  assert.deepEqual(valid.endpoints, ['ws://100.70.1.2:4400', 'ws://192.168.1.8:4400']);
  assert.throws(() => parsePairingPayload(JSON.stringify({ ...valid, endpoints: ['ws://8.8.8.8:4400'] })), /private-network/);
  assert.throws(() => parsePairingPayload(JSON.stringify({ ...valid, expiresAt: new Date(0).toISOString() })), /expired/);
});
