/**
 * Task 23 acceptance — enrolled-device relay client: tokens never on the relay
 * wire, challenge signatures verify against the enrolled key, revocation stops
 * the connection, and reconnects use a fresh single-use ticket (new epoch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { RemoteAccessClient, type BrokerSocketLike, type RemoteAccountFetch } from './remoteAccessClient.js';

class MemorySecrets {
  private readonly map = new Map<string, string>();
  get(key: string): string | null { return this.map.get(key) ?? null; }
  set(key: string, value: string): void { this.map.set(key, value); }
  delete(key: string): void { this.map.delete(key); }
}

class FakeSocket implements BrokerSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(public readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit('close', 1000); }
  on(event: string, listener: (...args: unknown[]) => void): void { this.once(event, listener); }
  once(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const listener of list) listener(...args);
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyWithEnrolledKey(publicKey: string, message: Buffer, signature: string): boolean {
  const raw = Buffer.from(publicKey.replace(/^ed25519:/, ''), 'base64url');
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return edVerify(null, message, key, Buffer.from(signature, 'base64url'));
}

interface Call { path: string; method: string; body: Record<string, unknown> }

function harness(overrides: { tickets?: string[] } = {}) {
  const secrets = new MemorySecrets();
  const calls: Call[] = [];
  const sockets: FakeSocket[] = [];
  const attached: FakeSocket[] = [];
  const tickets = overrides.tickets ?? ['rrt_TICKET-ONE', 'rrt_TICKET-TWO', 'rrt_TICKET-THREE'];
  let ticketIndex = 0;
  const challenge = Buffer.from('c'.repeat(32), 'utf8').toString('base64url');

  const accountFetch: RemoteAccountFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ path, method: init?.method ?? 'GET', body });
    const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
    if (path.endsWith('/enroll/challenge')) return json({ challengeId: 'chal-1', challenge });
    if (path.endsWith('/enroll/complete')) return json({ device: { id: 'dev-1' }, deviceSession: { id: 'sess-1', familyId: 'fam-1' } });
    if (path.endsWith('/device-sessions/rotate')) return json({ session: { id: 'sess-2', familyId: 'fam-1' } });
    if (path.endsWith('/desktop-tickets')) return json({ relayTicket: tickets[Math.min(ticketIndex++, tickets.length - 1)] });
    if (path.endsWith('/grants')) return json({ grants: [{ id: 'grant-1', approvalChallenge: Buffer.from('approve-me', 'utf8').toString('base64url') }] });
    if (path.includes('/grants/')) return json({ grant: { id: 'grant-1', approvalStatus: 'approved' } });
    return json({});
  };

  const client = new RemoteAccessClient({
    accountFetch,
    secrets,
    relayUrl: () => 'wss://relay.example.com',
    attachLocal: (socket) => attached.push(socket as FakeSocket),
    wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
  });
  return { client, secrets, calls, sockets, attached, challenge };
}

void test('enrollment signs the server challenge with the sealed installation key', async () => {
  const { client, secrets, calls, challenge } = harness();
  const identity = client.ensureIdentity();
  await client.enroll();

  const complete = calls.find((c) => c.path.endsWith('/enroll/complete'))!;
  assert.ok(verifyWithEnrolledKey(identity.publicKey, Buffer.from(challenge, 'base64url'), String(complete.body.signature)));
  assert.equal(secrets.get('remote.deviceId'), 'dev-1');
  assert.ok(String(secrets.get('remote.refreshToken')).length >= 32);
  assert.equal(client.isEnrolled(), true);
});

void test('no account bearer or refresh token ever enters relay frames or URLs', async () => {
  const { client, secrets, sockets } = harness();
  client.ensureIdentity();
  await client.enroll();
  await client.connect('grant-1', ['monitor']);

  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', JSON.stringify({ kind: 'attached' }));

  const refreshToken = secrets.get('remote.refreshToken')!;
  assert.ok(!socket.url.includes('?'), 'relay URL must carry no query credential');
  for (const frame of socket.sent) {
    assert.ok(!frame.includes(refreshToken), 'refresh token must never be framed');
    assert.ok(!frame.toLowerCase().includes('bearer'), 'bearer material must never be framed');
  }
  const attach = JSON.parse(socket.sent[0]) as Record<string, unknown>;
  assert.equal(attach.kind, 'attach');
  assert.equal(attach.ticket, 'rrt_TICKET-ONE');
  client.stop();
});

void test('attached sockets are handed to the local E2EE/RPC allowlist', async () => {
  const { client, sockets, attached } = harness();
  client.ensureIdentity();
  await client.enroll();
  await client.connect('grant-1', ['monitor']);
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ kind: 'attached' }));
  assert.equal(attached.length, 1);
  assert.equal(attached[0], sockets[0]);
  client.stop();
});

void test('revocation (4403) stops the client; other closes reconnect with a FRESH ticket', async () => {
  const { client, sockets } = harness();
  client.ensureIdentity();
  await client.enroll();
  await client.connect('grant-1', ['monitor']);
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ kind: 'attached' }));

  // Non-revocation close → a reconnect is scheduled with a NEW single-use ticket.
  sockets[0].emit('close', 1006);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 2);
  sockets[1].emit('open');
  const attach2 = JSON.parse(sockets[1].sent[0]) as Record<string, unknown>;
  assert.equal(attach2.ticket, 'rrt_TICKET-TWO');

  // Revocation close → permanent stop, no further sockets.
  sockets[1].emit('close', 4403);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(sockets.length, 2);
  client.stop();
});

void test('grant approval signs the server-issued approval challenge', async () => {
  const { client, calls } = harness();
  const identity = client.ensureIdentity();
  await client.enroll();
  assert.equal(await client.approveGrant('grant-1'), true);
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.body.action, 'approve');
  assert.ok(verifyWithEnrolledKey(identity.publicKey, Buffer.from('approve-me', 'utf8'), String(patch.body.signature)));
});

void test('session rotation swaps the stored refresh token', async () => {
  const { client, secrets } = harness();
  client.ensureIdentity();
  await client.enroll();
  const before = secrets.get('remote.refreshToken');
  assert.equal(await client.rotateSession(), true);
  const after = secrets.get('remote.refreshToken');
  assert.ok(before && after && before !== after);
  assert.equal(secrets.get('remote.deviceSessionId'), 'sess-2');
});
