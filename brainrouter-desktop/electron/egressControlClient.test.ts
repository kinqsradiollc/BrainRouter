/**
 * ADR-043 C5a acceptance — the standing egress control client: the hello carries
 * the enrolled-device identity + rotating token (never in the URL), `ready`
 * marks the channel live, each valid `dial` push reaches onDial, malformed dials
 * are dropped, and the channel reconnects with backoff / stops on demand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EgressControlClient,
  type EgressControlClientDeps,
  type EgressDialInstruction,
} from './egressControlClient.js';
import type { RemoteSecretsPort, BrokerSocketLike } from './remoteAccessClient.js';

class MemorySecrets implements RemoteSecretsPort {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

/** A socket whose `on` listeners PERSIST (the control channel receives many
 * messages) while `once` listeners fire a single time. */
class FakeSocket implements BrokerSocketLike {
  readyState = 1;
  sent: string[] = [];
  private on_ = new Map<string, Array<(...a: unknown[]) => void>>();
  private once_ = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(public readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.emit('close', code);
  }
  on(event: string, listener: (...a: unknown[]) => void): void {
    const list = this.on_.get(event) ?? [];
    list.push(listener);
    this.on_.set(event, list);
  }
  once(event: string, listener: (...a: unknown[]) => void): void {
    const list = this.once_.get(event) ?? [];
    list.push(listener);
    this.once_.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.on_.get(event) ?? []) listener(...args);
    const onces = this.once_.get(event) ?? [];
    this.once_.set(event, []);
    for (const listener of onces) listener(...args);
  }
}

const TOKEN = 'refresh-token-with-enough-entropy-0123456789';

function harness(deps: Partial<EgressControlClientDeps> = {}) {
  const secrets = new MemorySecrets();
  secrets.set('remote.deviceId', 'dev-1');
  secrets.set('remote.refreshToken', TOKEN);
  const sockets: FakeSocket[] = [];
  const dials: EgressDialInstruction[] = [];
  const client = new EgressControlClient({
    relayUrl: () => 'wss://relay.example.com',
    identity: () => ({ orgId: 'org-1', userId: 'user-1' }),
    secrets,
    wsFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onDial: (d) => dials.push(d),
    ...deps,
  });
  return { client, secrets, sockets, dials };
}

function dialFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'dial',
    clientToken: 'egt_a',
    sessionId: 's1',
    relayUrl: 'wss://relay.example.com/egress-relay',
    expiresAt: '2026-01-01T00:00:20.000Z',
    host: 'api.provider.test',
    port: 443,
    ...over,
  });
}

void test('hello carries org/user/device/token, never in the URL; ready marks the channel live', () => {
  const { client, sockets, secrets } = harness();
  client.start();
  const socket = sockets[0];
  assert.ok(socket.url.endsWith('/egress-control'));
  assert.ok(!socket.url.includes('?'), 'control URL must carry no query credential');

  socket.emit('open');
  const hello = JSON.parse(socket.sent[0]) as Record<string, unknown>;
  assert.equal(hello.kind, 'hello');
  assert.equal(hello.orgId, 'org-1');
  assert.equal(hello.userId, 'user-1');
  assert.equal(hello.deviceId, 'dev-1');
  assert.equal(hello.deviceToken, TOKEN);
  assert.ok(!socket.url.includes(secrets.get('remote.refreshToken')!), 'token must never be in the URL');

  assert.equal(client.isReady(), false);
  socket.emit('message', JSON.stringify({ kind: 'ready' }));
  assert.equal(client.isReady(), true);
  client.stop();
});

void test('delivers each valid dial push to onDial over the persistent channel', () => {
  const { client, sockets, dials } = harness();
  client.start();
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', JSON.stringify({ kind: 'ready' }));
  socket.emit('message', dialFrame({ clientToken: 'egt_a', host: 'api.provider.test', port: 443 }));
  socket.emit('message', dialFrame({ clientToken: 'egt_b', host: 'api2.provider.test', port: 8443 }));
  assert.equal(dials.length, 2);
  assert.equal(dials[0].clientToken, 'egt_a');
  assert.equal(dials[0].host, 'api.provider.test');
  assert.equal(dials[1].port, 8443);
  client.stop();
});

void test('ignores malformed dial frames (bad port, empty host, missing field, non-JSON)', () => {
  const { client, sockets, dials } = harness();
  client.start();
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', dialFrame({ port: 70_000 })); // out of range
  socket.emit('message', dialFrame({ port: 0 })); // non-positive
  socket.emit('message', dialFrame({ host: '' })); // empty host
  socket.emit('message', dialFrame({ clientToken: undefined })); // missing token
  socket.emit('message', 'not json');
  assert.equal(dials.length, 0);
  client.stop();
});

void test('does not open a socket until identity + credentials are available', async () => {
  let identity: { orgId: string; userId: string } | null = null;
  const { client, sockets } = harness({ identity: () => identity });
  client.start();
  assert.equal(sockets.length, 0, 'no socket without an identity');
  identity = { orgId: 'org-1', userId: 'user-1' };
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 1, 'a socket opens once identity is present');
  client.stop();
});

void test('reconnects with backoff after a non-clean close', async () => {
  const { client, sockets } = harness();
  client.start();
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify({ kind: 'ready' }));
  sockets[0].emit('close', 1006);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 2);
  assert.ok(sockets[1].url.endsWith('/egress-control'));
  client.stop();
});

void test('stop() closes the socket and cancels any reconnect', async () => {
  const { client, sockets } = harness();
  client.start();
  sockets[0].emit('open');
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(sockets.length, 1, 'no reconnect after stop');
  assert.equal(client.isReady(), false);
});
