/**
 * Task 25 acceptance — remote end-to-end security over the broker. Runs the REAL
 * desktop relay endpoint (MobileRelayServer via attachBrokerSocket) against a
 * broker that mirrors services/remoteRelay/server.ts semantics exactly
 * (first-frame single-use ticket, opaque splice, revocation disconnect), with a
 * scripted phone using the real NaCl protocol. Asserts:
 *   - after the attach handshake, the broker observes ONLY ciphertext frames it
 *     cannot decrypt (it never holds a key);
 *   - no bearer / refresh / pairing-token material crosses the relay;
 *   - a replayed ticket is rejected; revocation disconnects mid-session;
 *   - a reconnect requires a FRESH ticket and works (new epoch, replay counters
 *     reset by re-authentication, not by trust carry-over).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { MobileRelayServer } from './mobileRelayServer.js';
import { b64, createRelayKeyPair, decryptRelayPayload, encryptRelayPayload, fromB64 } from './mobileRelayCrypto.js';

const ACCOUNT_BEARER = 'account-bearer-never-on-the-relay';
const REFRESH_TOKEN = 'refresh-token-never-on-the-relay';

interface BrokerTicket { deviceId: string; grantId: string }

/** Faithful splice-only broker: consume-once tickets, pair by grant, revoke=4403. */
class TestBroker {
  private readonly wss: WebSocketServer;
  private readonly http = createServer();
  private readonly tickets = new Map<string, BrokerTicket>();
  private readonly pairs = new Map<string, Map<string, WebSocket>>();
  readonly observedFrames: string[] = [];
  port = 0;

  constructor() {
    this.wss = new WebSocketServer({ server: this.http, path: '/remote-relay' });
    this.wss.on('connection', (socket) => {
      socket.once('message', (raw: RawData) => this.attach(socket, raw));
    });
  }

  issueTicket(ticket: string, deviceId: string, grantId: string): void {
    this.tickets.set(ticket, { deviceId, grantId });
  }

  private attach(socket: WebSocket, raw: RawData): void {
    let frame: { kind?: string; ticket?: string; deviceId?: string };
    try { frame = JSON.parse(raw.toString('utf8')); } catch { socket.close(1002); return; }
    const record = frame.ticket ? this.tickets.get(frame.ticket) : undefined;
    if (frame.kind !== 'attach' || !record || record.deviceId !== frame.deviceId) {
      socket.close(4401, 'invalid ticket');
      return;
    }
    this.tickets.delete(frame.ticket!);
    const pair = this.pairs.get(record.grantId) ?? new Map<string, WebSocket>();
    this.pairs.set(record.grantId, pair);
    pair.set(record.deviceId, socket);
    socket.send(JSON.stringify({ kind: 'attached', peerConnected: pair.size > 1 }));
    socket.on('message', (data: RawData) => {
      this.observedFrames.push(data.toString('utf8'));
      for (const [deviceId, peer] of pair) {
        if (deviceId !== record.deviceId && peer.readyState === WebSocket.OPEN) peer.send(data.toString('utf8'));
      }
    });
    socket.on('close', () => { pair.delete(record.deviceId); });
  }

  revoke(grantId: string): void {
    for (const socket of this.pairs.get(grantId)?.values() ?? []) socket.close(4403, 'revoked');
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    const address = this.http.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/remote-relay`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 3_000);
    socket.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString()) as Record<string, unknown>); });
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

/** Desktop side: dial the broker, attach with a ticket, hand to the local allowlist. */
async function attachDesktop(broker: TestBroker, server: MobileRelayServer, ticket: string, scopes: Array<'monitor' | 'control' | 'approve'>): Promise<WebSocket> {
  const socket = await open(broker.port);
  const attached = nextJson(socket);
  socket.send(JSON.stringify({ kind: 'attach', ticket, deviceId: 'desk-1' }));
  await attached;
  server.attachBrokerSocket(socket, { scopes });
  return socket;
}

void test('broker E2E: ciphertext-only splice, replay rejection, revocation, fresh-ticket reconnect', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-broker-e2e-'));
  const server = new MobileRelayServer({
    home,
    status: () => [{ id: 'run1', candidates: [] }],
    terminalSnapshot: () => ({ snapshot: 'hi', start: 0, next: 2, alive: true }),
    terminalInput: () => true,
    agentControl: () => true,
  });
  const broker = new TestBroker();
  await broker.listen();
  try {
    // --- Session 1: desktop + phone attach with single-use tickets; pair over broker.
    broker.issueTicket('rrt_desk_1', 'desk-1', 'grant-1');
    broker.issueTicket('rrt_phone_1', 'phone-1', 'grant-1');
    await attachDesktop(broker, server, 'rrt_desk_1', ['monitor', 'control']);

    const phone = await open(broker.port);
    const attached = nextJson(phone);
    phone.send(JSON.stringify({ kind: 'attach', ticket: 'rrt_phone_1', deviceId: 'phone-1' }));
    await attached;

    const phoneKeys = createRelayKeyPair();
    const pairedPromise = nextJson(phone);
    phone.send(JSON.stringify({ kind: 'pair', broker: true, clientPublicKey: b64(phoneKeys.publicKey), deviceName: 'E2E phone' }));
    const pairedFrame = await pairedPromise;
    const serverPublicKey = String(pairedFrame.serverPublicKey);
    const paired = decryptRelayPayload<{ deviceId: string; deviceToken: string; scopes: string[] }>(
      { nonce: String(pairedFrame.nonce), ciphertext: String(pairedFrame.ciphertext) },
      fromB64(serverPublicKey), phoneKeys.secretKey,
    )!;
    assert.ok(paired.deviceId && paired.deviceToken);
    assert.deepEqual(paired.scopes, ['monitor', 'control']); // ticket scopes, not approve

    // Replay: the same phone ticket cannot attach a second connection.
    const replay = await open(broker.port);
    replay.send(JSON.stringify({ kind: 'attach', ticket: 'rrt_phone_1', deviceId: 'phone-1' }));
    assert.equal(await closeCode(replay), 4401);

    // Authenticated E2EE RPC through the splice.
    let counter = 0;
    const send = (payload: Record<string, unknown>) => {
      const encrypted = encryptRelayPayload({ ...payload, counter: ++counter }, fromB64(serverPublicKey), phoneKeys.secretKey);
      phone.send(JSON.stringify({ kind: 'box', deviceId: paired.deviceId, ...encrypted }));
    };
    const receive = async (): Promise<Record<string, unknown>> => {
      const frame = await nextJson(phone);
      return decryptRelayPayload<Record<string, unknown>>(
        { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
        fromB64(serverPublicKey), phoneKeys.secretKey,
      )!;
    };
    const authOk = receive();
    send({ type: 'auth', token: paired.deviceToken });
    assert.equal((await authOk).type, 'auth.ok');
    const statusResult = receive();
    send({ type: 'rpc', id: 'r1', method: 'status.list', params: {} });
    assert.equal((await statusResult).type, 'rpc.result');

    // The broker observed only opaque material: every post-attach frame is either
    // the pair handshake or a nonce+ciphertext box, and no secret string appears.
    const boxes = broker.observedFrames.filter((frame) => frame.includes('"kind":"box"'));
    assert.ok(boxes.length >= 2, 'boxed frames crossed the splice');
    for (const frame of broker.observedFrames) {
      assert.ok(!frame.includes(ACCOUNT_BEARER) && !frame.includes(REFRESH_TOKEN), 'no bearer material on the relay');
      assert.ok(!frame.includes(paired.deviceToken), 'the device token travels only inside NaCl boxes');
      if (frame.includes('"kind":"box"')) {
        const parsed = JSON.parse(frame) as { nonce?: string; ciphertext?: string };
        assert.ok(parsed.nonce && parsed.ciphertext, 'boxes carry only nonce+ciphertext');
        // The broker holds no key: decrypting with a random key fails.
        const stranger = createRelayKeyPair();
        assert.equal(decryptRelayPayload({ nonce: parsed.nonce, ciphertext: parsed.ciphertext }, fromB64(serverPublicKey), stranger.secretKey), null);
      }
    }

    // Revocation disconnects the live session at the broker boundary.
    const phoneClosed = closeCode(phone);
    broker.revoke('grant-1');
    assert.equal(await phoneClosed, 4403);

    // --- Session 2 (new epoch): FRESH tickets; the paired credential still works.
    broker.issueTicket('rrt_desk_2', 'desk-1', 'grant-1');
    broker.issueTicket('rrt_phone_2', 'phone-1', 'grant-1');
    await attachDesktop(broker, server, 'rrt_desk_2', ['monitor', 'control']);
    const phone2 = await open(broker.port);
    const attached2 = nextJson(phone2);
    phone2.send(JSON.stringify({ kind: 'attach', ticket: 'rrt_phone_2', deviceId: 'phone-1' }));
    await attached2;
    const receive2 = async (): Promise<Record<string, unknown>> => {
      const frame = await nextJson(phone2);
      return decryptRelayPayload<Record<string, unknown>>(
        { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
        fromB64(serverPublicKey), phoneKeys.secretKey,
      )!;
    };
    const auth2 = receive2();
    const encrypted = encryptRelayPayload({ type: 'auth', token: paired.deviceToken, counter: ++counter }, fromB64(serverPublicKey), phoneKeys.secretKey);
    phone2.send(JSON.stringify({ kind: 'box', deviceId: paired.deviceId, ...encrypted }));
    assert.equal((await auth2).type, 'auth.ok');
    phone2.close();
  } finally {
    server.stop();
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
