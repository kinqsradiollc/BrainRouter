import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { MobileRelayServer, relayAdvertiseHosts } from './mobileRelayServer.js';
import { b64, createRelayKeyPair, decryptRelayPayload, encryptRelayPayload, fromB64 } from './mobileRelayCrypto.js';

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 3_000);
    socket.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString()) as Record<string, unknown>); });
  });
}

test('advertised relay endpoints prefer Tailscale, then private LAN, and never wildcard', () => {
  const hosts = relayAdvertiseHosts(true, {
    en0: [{ address: '192.168.1.8', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.1.8/24' }],
    utun: [{ address: '100.88.1.2', netmask: '255.192.0.0', family: 'IPv4', mac: '', internal: false, cidr: '100.88.1.2/10' }],
  });
  assert.deepEqual(hosts, ['100.88.1.2', '192.168.1.8', '127.0.0.1']);
  assert.ok(!hosts.includes('0.0.0.0'));
});

test('pairs, authenticates, authorizes RPC, enforces floor, and rejects replay', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-relay-'));
  const writes: string[] = [];
  const server = new MobileRelayServer({
    home,
    status: () => [{ id: 'run1', candidates: [{ id: 'c1', status: 'working' }] }],
    terminalSnapshot: () => ({ snapshot: 'hello', start: 0, next: 5, alive: true }),
    terminalInput: (_id, data) => { writes.push(data); return true; },
    agentControl: () => true,
  });
  try {
    await server.start({ port: 0 });
    const pairing = server.createPairing(['monitor', 'control', 'approve']);
    const phone = createRelayKeyPair();
    const socket = new WebSocket(pairing.endpoints[0]!);
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    socket.send(JSON.stringify({ kind: 'pair', pairingToken: pairing.pairingToken, clientPublicKey: b64(phone.publicKey), deviceName: 'Test phone' }));
    const pairedFrame = await nextJson(socket);
    const paired = decryptRelayPayload<{ deviceId: string; deviceToken: string }>(
      { nonce: String(pairedFrame.nonce), ciphertext: String(pairedFrame.ciphertext) },
      fromB64(pairing.serverPublicKey), phone.secretKey,
    )!;
    assert.ok(paired.deviceId);
    assert.ok(paired.deviceToken);

    const send = (payload: Record<string, unknown>) => {
      const encrypted = encryptRelayPayload(payload, fromB64(pairing.serverPublicKey), phone.secretKey);
      socket.send(JSON.stringify({ kind: 'box', deviceId: paired.deviceId, ...encrypted }));
    };
    const receive = async () => {
      const frame = await nextJson(socket);
      return decryptRelayPayload<Record<string, unknown>>(
        { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
        fromB64(pairing.serverPublicKey), phone.secretKey,
      )!;
    };

    send({ type: 'auth', token: paired.deviceToken, counter: 1 });
    assert.equal((await receive()).type, 'auth.ok');
    send({ type: 'rpc', id: 'r1', method: 'status.list', counter: 2 });
    assert.equal((await receive()).type, 'rpc.result');
    send({ type: 'rpc', id: 'r2', method: 'floor.acquire', params: { candidateId: 'c1' }, counter: 3 });
    const floor = await receive();
    assert.equal((floor.result as { acquired: boolean }).acquired, true);
    send({ type: 'rpc', id: 'r3', method: 'terminal.input', params: { candidateId: 'c1', data: 'ls\r' }, counter: 4 });
    assert.equal((await receive()).type, 'rpc.result');
    assert.deepEqual(writes, ['ls\r']);
    send({ type: 'rpc', id: 'r4', method: 'process.exec', counter: 5 });
    assert.equal((await receive()).error, 'method-not-allowed');

    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    send({ type: 'rpc', id: 'replay', method: 'status.list', counter: 5 });
    assert.equal(await closed, 1008);
  } finally {
    server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
