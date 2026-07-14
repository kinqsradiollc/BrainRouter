/**
 * Task 24 acceptance — mobile login/discovery/broker client: enrollment signs the
 * server challenge with a device-held Ed25519 key, discovery returns presence
 * freshness, and broker traffic carries the single-use ticket ONLY (no account
 * bearer, no refresh token, no pairing token).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { RemoteAccessClient, type RemoteSecretsPort } from './RemoteAccessClient';
import { RelayClient, type SocketLike } from './RelayClient';
import { b64, b64url, fromB64url, encryptPayload } from '../protocol/crypto';
import type { HostCredential } from '../protocol/types';
import type { CredentialStore } from '../storage/credentials';

class MemorySecrets implements RemoteSecretsPort {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.map.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

class MemoryCredentials implements CredentialStore {
  private readonly map = new Map<string, HostCredential>();
  async list(): Promise<HostCredential[]> { return [...this.map.values()]; }
  async get(id: string): Promise<HostCredential | null> { return this.map.get(id) ?? null; }
  async put(value: HostCredential): Promise<void> { this.map.set(value.id, value); }
  async remove(id: string): Promise<void> { this.map.delete(id); }
}

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  constructor(public readonly url: string, private readonly script: (socket: FakeSocket, frame: Record<string, unknown>) => void) {
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string): void {
    this.sent.push(data);
    this.script(this, JSON.parse(data) as Record<string, unknown>);
  }
  close(): void { this.onclose?.({ code: 1000 }); }
  reply(value: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const BEARER = 'account-bearer-token-should-never-ride-relay';
const challenge = b64url(nacl.randomBytes(32));

function accountFetchStub(calls: Array<{ path: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path.endsWith('/enroll/challenge')) return json({ challengeId: 'chal-1', challenge });
    if (path.endsWith('/enroll/complete')) return json({ device: { id: 'phone-dev-1' }, deviceSession: { id: 'sess-1' } });
    if (path.endsWith('/desktops')) return json({ desktops: [{ id: 'desk-1', displayName: 'Studio Mac', presence: 'online', lastSeenAt: '2026-07-14T00:00:00.000Z', status: 'active' }] });
    if (path.includes('/grants')) return json({ grant: { id: 'grant-1', desktopDeviceId: 'desk-1', scopes: ['monitor'], approvalStatus: 'pending', expiresAt: '2026-07-15T00:00:00.000Z' } });
    if (path.endsWith('/sessions')) return json({ relayTicket: `rrt_${'A'.repeat(43)}`, relaySessionId: 'rrs-1', scopes: ['monitor'], presentingDeviceId: 'phone-dev-1', peerDeviceId: 'desk-1', expiresAt: '2026-07-14T00:01:00.000Z' });
    return json({});
  }) as typeof fetch;
}

void test('enrollment signs the challenge with the phone-held Ed25519 key', async () => {
  const secrets = new MemorySecrets();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new RemoteAccessClient('https://api.brainrouter.ai', BEARER, secrets, accountFetchStub(calls));
  await client.enroll('Anh iPhone');

  const complete = calls.find((c) => c.path.endsWith('/enroll/complete'))!;
  const challengeBody = calls.find((c) => c.path.endsWith('/enroll/challenge'))!;
  const publicKey = fromB64url(String(challengeBody.body.publicKey).replace(/^ed25519:/, ''));
  assert.ok(nacl.sign.detached.verify(fromB64url(challenge), fromB64url(String(complete.body.signature)), publicKey));
  assert.equal(await client.isEnrolled(), true);
  assert.ok((await secrets.get('remote.refreshToken'))!.length >= 32);
});

void test('discovery returns presence freshness and never endpoints or IPs', async () => {
  const secrets = new MemorySecrets();
  const client = new RemoteAccessClient('https://api.brainrouter.ai', BEARER, secrets, accountFetchStub([]));
  const desktops = await client.listDesktops();
  assert.deepEqual(desktops, [{ id: 'desk-1', displayName: 'Studio Mac', presence: 'online', lastSeenAt: '2026-07-14T00:00:00.000Z', status: 'active' }]);
});

void test('broker pairing frames carry no bearer, refresh, or pairing token', async () => {
  const serverKeys = nacl.box.keyPair();
  const sockets: FakeSocket[] = [];
  const script = (socket: FakeSocket, frame: Record<string, unknown>): void => {
    if (frame.kind === 'attach') { socket.reply({ kind: 'attached', relaySessionId: 'rrs-1', peerConnected: true }); return; }
    if (frame.kind === 'pair') {
      const clientKey = Buffer.from(String(frame.clientPublicKey), 'base64');
      const encrypted = encryptPayload({ type: 'paired', deviceId: 'device_remote1', deviceToken: 'tok_'.padEnd(40, 'x'), scopes: ['monitor'] }, new Uint8Array(clientKey), serverKeys.secretKey);
      socket.reply({ kind: 'paired', deviceId: 'device_remote1', serverPublicKey: b64(serverKeys.publicKey), ...encrypted });
    }
  };
  const store = new MemoryCredentials();
  const relay = new RelayClient(store, (url) => { const s = new FakeSocket(url, script); sockets.push(s); return s; });
  const credential = await relay.pairViaBroker({ url: 'wss://relay.brainrouter.ai/remote-relay', ticket: `rrt_${'B'.repeat(43)}`, deviceId: 'phone-dev-1' }, 'Anh iPhone');

  assert.equal(credential.deviceId, 'device_remote1');
  const socket = sockets[0];
  assert.ok(!socket.url.includes('?'), 'ticket must not ride the URL');
  const attach = JSON.parse(socket.sent[0]) as Record<string, unknown>;
  assert.equal(attach.kind, 'attach');
  const pairFrame = JSON.parse(socket.sent[1]) as Record<string, unknown>;
  assert.equal(pairFrame.broker, true);
  assert.equal(pairFrame.accountToken, undefined);
  assert.equal(pairFrame.pairingToken, undefined);
  for (const frame of socket.sent) {
    assert.ok(!frame.includes(BEARER), 'account bearer must never ride the relay');
  }
});

void test('connectViaBroker attaches first, then authenticates over E2EE', async () => {
  const serverKeys = nacl.box.keyPair();
  const clientKeys = nacl.box.keyPair();
  const store = new MemoryCredentials();
  await store.put({
    id: 'device_remote1', name: 'Studio Mac', endpoints: [],
    serverPublicKey: b64(serverKeys.publicKey), clientPublicKey: b64(clientKeys.publicKey),
    clientSecretKey: b64(clientKeys.secretKey), deviceId: 'device_remote1',
    deviceToken: 'tok_'.padEnd(40, 'x'), scopes: ['monitor'], counter: 0, pairedAt: '2026-07-14T00:00:00.000Z',
  });
  const script = (socket: FakeSocket, frame: Record<string, unknown>): void => {
    if (frame.kind === 'attach') { socket.reply({ kind: 'attached', relaySessionId: 'rrs-1', peerConnected: true }); return; }
    if (frame.kind === 'box') {
      const encrypted = encryptPayload({ type: 'auth.ok', deviceId: 'device_remote1', scopes: ['monitor'], counter: 1 }, clientKeys.publicKey, serverKeys.secretKey);
      socket.reply(encrypted);
    }
  };
  const sockets: FakeSocket[] = [];
  const relay = new RelayClient(store, (url) => { const s = new FakeSocket(url, script); sockets.push(s); return s; });
  await relay.connectViaBroker('device_remote1', { url: 'wss://relay.brainrouter.ai/remote-relay', ticket: `rrt_${'C'.repeat(43)}`, deviceId: 'phone-dev-1' });

  const socket = sockets[0];
  const first = JSON.parse(socket.sent[0]) as Record<string, unknown>;
  assert.equal(first.kind, 'attach');
  const second = JSON.parse(socket.sent[1]) as Record<string, unknown>;
  assert.equal(second.kind, 'box');
  assert.ok(!socket.sent[1].includes('tok_'), 'device token travels only inside the E2EE box');
  relay.close();
});
