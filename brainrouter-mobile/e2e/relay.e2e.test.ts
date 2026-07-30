import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient, type SocketLike } from '../src/client/RelayClient';
import type { CredentialStore } from '../src/storage/credentials';
import { b64, createDeviceKeyPair, decryptPayload, encryptPayload, fromB64 } from '../src/protocol/crypto';
import type { HostCredential } from '../src/protocol/types';

class TestStore implements CredentialStore {
  values = new Map<string, HostCredential>();
  async list() { return [...this.values.values()].map((value) => structuredClone(value)); }
  async get(id: string) { const value = this.values.get(id); return value ? structuredClone(value) : null; }
  async put(value: HostCredential) { this.values.set(value.id, structuredClone(value)); }
  async remove(id: string) { this.values.delete(id); }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  constructor(private server: FakeRelay) { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data: string): void { this.server.receive(this, data); }
  close(code = 1000): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  deliver(value: unknown): void { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
}

class FakeRelay {
  readonly keys = createDeviceKeyPair();
  sockets: FakeSocket[] = [];
  clientPublicKey?: Uint8Array;
  deviceToken = 'device-token';
  deviceId = 'device-1';
  lastClientCounter = 0;
  serverCounters = new WeakMap<FakeSocket, number>();
  active?: FakeSocket;
  createSocket = (): FakeSocket => { const socket = new FakeSocket(this); this.sockets.push(socket); return socket; };
  receive(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.kind === 'pair') {
      this.clientPublicKey = fromB64(String(frame.clientPublicKey));
      const encrypted = encryptPayload({ type: 'paired', deviceId: this.deviceId, deviceToken: this.deviceToken, scopes: ['monitor', 'control', 'approve'] }, this.clientPublicKey, this.keys.secretKey);
      socket.deliver({ kind: 'paired', deviceId: this.deviceId, serverPublicKey: b64(this.keys.publicKey), ...encrypted });
      return;
    }
    const payload = decryptPayload<Record<string, unknown>>(
      { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
      this.clientPublicKey!, this.keys.secretKey,
    )!;
    const counter = Number(payload.counter);
    if (counter <= this.lastClientCounter) { socket.close(1008); return; }
    this.lastClientCounter = counter;
    this.active = socket;
    if (payload.type === 'auth') { this.send(socket, { type: 'auth.ok', scopes: ['monitor', 'control', 'approve'] }); return; }
    const id = String(payload.id);
    const method = String(payload.method);
    if (method === 'fanout.list') this.send(socket, { type: 'rpc.result', id, result: [{ id: 'run1', task: 'Ship it', status: 'running', candidates: [{ id: 'c1', adapterId: 'codex', status: 'working', changedFiles: 2 }] }] });
    else if (method === 'floor.acquire') this.send(socket, { type: 'rpc.result', id, result: { acquired: true } });
    else this.send(socket, { type: 'rpc.result', id, result: { ok: true } });
  }
  event(event: Record<string, unknown>): void { if (this.active) this.send(this.active, { type: 'event', ...event }); }
  private send(socket: FakeSocket, payload: Record<string, unknown>): void {
    const counter = (this.serverCounters.get(socket) ?? 0) + 1;
    this.serverCounters.set(socket, counter);
    const encrypted = encryptPayload({ ...payload, counter }, this.clientPublicKey!, this.keys.secretKey);
    socket.deliver({ kind: 'box', deviceId: this.deviceId, counter, ...encrypted });
  }
}

test('mobile client pairs, reconnects, monitors, acquires floor, and receives terminal/completion events', async () => {
  const server = new FakeRelay();
  const store = new TestStore();
  const client = new RelayClient(store, server.createSocket);
  const events: string[] = [];
  client.subscribe((event) => { if (event.type === 'event') events.push(event.event); else events.push(event.state); });
  const pairing = JSON.stringify({ version: 1, endpoints: ['ws://127.0.0.1:4000'], serverPublicKey: b64(server.keys.publicKey), pairingToken: 'once', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const host = await client.pair(pairing, 'Desktop');
  assert.equal((await store.get(host.id))?.deviceToken, 'device-token');

  await client.connect(host.id);
  const runs = await client.rpc<Array<{ id: string }>>('fanout.list');
  assert.equal(runs[0]?.id, 'run1');
  assert.equal(await client.acquireFloor('c1'), true);
  await client.subscribeTerminal('c1');
  server.event({ event: 'terminal.output', candidateId: 'c1', chunk: 'hello' });
  server.event({ event: 'agent.completed', candidateId: 'c1', status: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.includes('terminal.output'));
  assert.ok(events.includes('agent.completed'));

  server.active?.close(1006);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.ok(server.sockets.length >= 3, 'pair socket + initial connection + reconnect');
  assert.ok(events.filter((event) => event === 'connected').length >= 2);
  client.close();
});
