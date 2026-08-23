/**
 * ADR-043 C5-wire acceptance — the desktop egress tunnel factory: the config
 * readers resolve identity/URL/gate safely, the raw-TCP adapter dials the PINNED
 * address, and the assembled control client sends a hello carrying the active
 * account + enrolled device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveActiveIdentity,
  resolveEgressControlUrl,
  egressTunnelEnabled,
  netTcpConnect,
  createEgressTunnelClient,
} from './egressTunnelWiring.js';
import type { BrokerSocketLike } from '../remoteAccessClient.js';

test('resolveActiveIdentity returns (org,user) only when both are present', () => {
  assert.deepEqual(resolveActiveIdentity({ cli: { account: { orgId: 'o', userId: 'u' } } }), { orgId: 'o', userId: 'u' });
  assert.equal(resolveActiveIdentity({ cli: { account: { userId: 'u' } } }), null); // personal / no org
  assert.equal(resolveActiveIdentity({ cli: { account: { orgId: 'o' } } }), null);
  assert.equal(resolveActiveIdentity({}), null);
});

test('resolveEgressControlUrl accepts wss (+ ws loopback), rejects cleartext elsewhere', () => {
  assert.equal(resolveEgressControlUrl({ cli: { remote: { egressControlUrl: 'wss://gw.example.com/egress-control/' } } }), 'wss://gw.example.com/egress-control');
  assert.equal(resolveEgressControlUrl({ cli: { remote: { egressControlUrl: 'ws://127.0.0.1:3749' } } }), 'ws://127.0.0.1:3749');
  assert.equal(resolveEgressControlUrl({ cli: { remote: { egressControlUrl: 'ws://gw.example.com' } } }), null); // cleartext, non-loopback
  assert.equal(resolveEgressControlUrl({ cli: { remote: { egressControlUrl: 'not a url' } } }), null);
  assert.equal(resolveEgressControlUrl({}), null);
});

test('egressTunnelEnabled is true only for an explicit boolean true', () => {
  assert.equal(egressTunnelEnabled({ cli: { remote: { egressTunnel: true } } }), true);
  assert.equal(egressTunnelEnabled({ cli: { remote: { egressTunnel: 'true' } } }), false);
  assert.equal(egressTunnelEnabled({ cli: { remote: {} } }), false);
  assert.equal(egressTunnelEnabled({}), false);
});

test('netTcpConnect dials the pinned address:port and relays bytes both ways', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const port: number = await new Promise((resolve) => {
    echo.listen(0, '127.0.0.1', () => {
      const addr = echo.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  try {
    const tcp = netTcpConnect({ address: '127.0.0.1', family: 4, port });
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tcp.on('connect', () => tcp.write(Buffer.from('ping')));
      tcp.on('data', (...args: unknown[]) => {
        received.push(args[0] as Buffer);
        resolve();
      });
      tcp.on('error', (...args: unknown[]) => reject(args[0]));
    });
    assert.equal(Buffer.concat(received).toString('utf8'), 'ping');
    tcp.destroy();
  } finally {
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

/** A minimal control-channel socket capturing what the client sends. */
class FakeControl implements BrokerSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(public readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', 1000);
  }
  on(event: string, listener: (...a: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  once(event: string, listener: (...a: unknown[]) => void): void {
    this.on(event, listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

test('createEgressTunnelClient assembles a client whose hello carries the active account + enrolled device', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-wire-'));
  fs.mkdirSync(path.join(home, 'mobile'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'mobile', 'remote-device.json'),
    JSON.stringify({ 'remote.deviceId': 'dev-xyz', 'remote.refreshToken': 'refresh-token-with-enough-entropy-0123456789' }),
  );
  const config = {
    cli: {
      account: { orgId: 'org-1', userId: 'user-1' },
      remote: { egressControlUrl: 'wss://gw.example.com/egress-control', egressTunnel: true },
    },
  };
  const controls: FakeControl[] = [];
  const client = createEgressTunnelClient({
    home,
    loadConfigFn: () => config,
    controlWsFactory: (url) => {
      const c = new FakeControl(url);
      controls.push(c);
      return c;
    },
    relayWsFactory: () => {
      throw new Error('no relay expected in this test');
    },
    tcpConnect: () => {
      throw new Error('no dial expected in this test');
    },
  });
  try {
    client.start();
    assert.equal(controls.length, 1);
    assert.ok(controls[0].url.endsWith('/egress-control'));
    controls[0].emit('open');
    const hello = JSON.parse(controls[0].sent[0]) as Record<string, unknown>;
    assert.equal(hello.kind, 'hello');
    assert.equal(hello.orgId, 'org-1');
    assert.equal(hello.userId, 'user-1');
    assert.equal(hello.deviceId, 'dev-xyz');
    assert.equal(hello.deviceToken, 'refresh-token-with-enough-entropy-0123456789');
  } finally {
    client.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
