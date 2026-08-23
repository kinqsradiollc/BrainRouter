/**
 * ADR-043 C5b acceptance — the edge dial handler. Happy path attaches with the
 * ticket, vets + dials the server-named target, acks `dialed`, and splices bytes
 * both ways; every refusal (target mismatch, blocked/SSRF target, expired ticket,
 * malformed instruction, provider error) replies `dialed:{ok:false}` and opens no
 * provider socket (or tears it down), so the gateway falls back to direct egress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EdgeDialHandler,
  type RelaySocketLike,
  type TcpSocketLike,
  type EdgeDialHandlerDeps,
} from './egressDialHandler.js';
import type { EgressDialInstruction } from './egressControlClient.js';
import type { VettedTarget } from './edgeDialGuard.js';
import { DialNotAllowedError } from './edgeDialGuard.js';

class FakeRelay implements RelaySocketLike {
  sent: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  closed = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(public readonly url: string) {}
  send(data: string | Uint8Array, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: !!opts?.binary });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  on(event: string, listener: (...a: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  binaryFrames(): Uint8Array[] {
    return this.sent.filter((s) => s.binary).map((s) => s.data as Uint8Array);
  }
}

class FakeTcp implements TcpSocketLike {
  written: Uint8Array[] = [];
  destroyed = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  write(data: Uint8Array): void {
    this.written.push(data);
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  on(event: string, listener: (...a: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const PUBLIC: VettedTarget = { address: '104.18.2.3', family: 4, port: 443 };

function instruction(over: Partial<EgressDialInstruction> = {}): EgressDialInstruction {
  return {
    clientToken: 'egt_client',
    sessionId: 's1',
    relayUrl: 'wss://relay.example.com/egress-relay',
    expiresAt: '2026-01-01T00:00:20.000Z',
    host: 'api.provider.test',
    port: 443,
    ...over,
  };
}

function harness(deps: Partial<EdgeDialHandlerDeps> = {}) {
  const relays: FakeRelay[] = [];
  const tcps: FakeTcp[] = [];
  const handler = new EdgeDialHandler({
    relayWsFactory: (url) => {
      const r = new FakeRelay(url);
      relays.push(r);
      return r;
    },
    tcpConnect: () => {
      const t = new FakeTcp();
      tcps.push(t);
      return t;
    },
    deviceId: () => 'dev-1',
    vet: async () => PUBLIC,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    ...deps,
  });
  return { handler, relays, tcps };
}

const dialFrame = (host = 'api.provider.test', port = 443): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'dial', host, port }));
const decode = (frame: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

void test('happy path: attaches with the ticket, vets, dials, acks, and splices both ways', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction());
  const relay = relays[0];
  assert.ok(relay.url.endsWith('/egress-relay'));

  relay.emit('open');
  const attach = JSON.parse(relay.sent[0].data as string) as Record<string, unknown>;
  assert.equal(attach.kind, 'attach');
  assert.equal(attach.ticket, 'egt_client');
  assert.equal(attach.deviceId, 'dev-1');

  relay.emit('message', dialFrame(), true);
  await flush();
  const tcp = tcps[0];
  assert.ok(tcp, 'a provider socket was opened');
  tcp.emit('connect');

  const ack = decode(relay.binaryFrames()[0]);
  assert.equal(ack.kind, 'dialed');
  assert.equal(ack.ok, true);

  // relay ciphertext → provider
  relay.emit('message', new Uint8Array([1, 2, 3]), true);
  assert.deepEqual(Array.from(tcp.written[0]), [1, 2, 3]);
  // provider bytes → relay (binary)
  tcp.emit('data', Buffer.from([9, 8, 7]));
  const frames = relay.binaryFrames();
  assert.deepEqual(Array.from(frames[frames.length - 1]), [9, 8, 7]);
});

void test('refuses (dialed:false) and opens no socket when the ticket has expired', () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction({ expiresAt: '2025-01-01T00:00:00.000Z' }));
  assert.equal(relays.length, 0, 'no relay socket for an expired ticket');
  assert.equal(tcps.length, 0);
});

void test('refuses when the relay-delivered target diverges from the control-push target', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction({ host: 'api.provider.test', port: 443 }));
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame('evil.internal', 8080), true); // mismatched
  await flush();
  assert.equal(tcps.length, 0, 'no provider socket on mismatch');
  const ack = decode(relay.binaryFrames()[0]);
  assert.equal(ack.ok, false);
  assert.ok(relay.closed);
});

void test('refuses when the SSRF guard blocks the target', async () => {
  const { handler, relays, tcps } = harness({
    vet: async () => {
      throw new DialNotAllowedError('target IP is in a blocked range');
    },
  });
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame(), true);
  await flush();
  assert.equal(tcps.length, 0, 'guard refusal opens no socket');
  const ack = decode(relay.binaryFrames()[0]);
  assert.equal(ack.ok, false);
  assert.match(String(ack.error), /blocked/);
  assert.ok(relay.closed);
});

void test('refuses a malformed dial instruction', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', new TextEncoder().encode('not json'), true);
  await flush();
  assert.equal(tcps.length, 0);
  assert.equal(decode(relay.binaryFrames()[0]).ok, false);
});

void test('refuses (dialed:false) when the provider connection errors', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame(), true);
  await flush();
  const tcp = tcps[0];
  tcp.emit('error', new Error('ECONNREFUSED'));
  const ack = decode(relay.binaryFrames()[0]);
  assert.equal(ack.ok, false);
  assert.ok(relay.closed);
});

void test('splits an oversized provider chunk at the relay frame ceiling', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame(), true);
  await flush();
  const tcp = tcps[0];
  tcp.emit('connect');
  const beforeAck = relay.binaryFrames().length; // the dialed ack
  tcp.emit('data', Buffer.alloc(200 * 1024, 7)); // > 128 KiB
  const dataFrames = relay.binaryFrames().slice(beforeAck);
  assert.equal(dataFrames.length, 2, 'one 200 KiB chunk → two frames');
  assert.equal(dataFrames[0].length, 128 * 1024);
  assert.equal(dataFrames[1].length, 200 * 1024 - 128 * 1024);
});

void test('connect timeout destroys the socket (no leak) and swallows late provider data', async () => {
  const { handler, relays, tcps } = harness({ connectTimeoutMs: 20 });
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame(), true);
  await flush();
  const tcp = tcps[0];
  assert.ok(tcp, 'a socket was created');
  await new Promise((resolve) => setTimeout(resolve, 40)); // let the connect timeout fire (socket never connects)
  assert.ok(tcp.destroyed, 'the never-connected socket is destroyed, not leaked');
  const ack = decode(relay.binaryFrames()[0]);
  assert.equal(ack.ok, false);
  assert.ok(relay.closed);
  // A late SYN-ACK arriving after the timeout, then data, must not throw.
  assert.doesNotThrow(() => {
    tcp.emit('connect');
    tcp.emit('data', Buffer.from([1, 2, 3]));
  });
});

void test('tears down the provider socket when the relay closes', async () => {
  const { handler, relays, tcps } = harness();
  handler.handle(instruction());
  const relay = relays[0];
  relay.emit('open');
  relay.emit('message', dialFrame(), true);
  await flush();
  const tcp = tcps[0];
  tcp.emit('connect');
  relay.emit('close');
  assert.ok(tcp.destroyed, 'provider socket destroyed with the relay');
});
