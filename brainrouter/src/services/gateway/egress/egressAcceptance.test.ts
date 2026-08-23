/**
 * ADR-043 §7 acceptance — the tunnel proven end-to-end at the transport layer:
 *   #1 provider-side traffic egresses through the CLIENT's own socket to a real
 *      separate target (not the gateway) and the response returns;
 *   #2 a tampered / refused dial fails the request CLOSED (so the ladder takes
 *      server egress) — never a hang or a wrong success;
 *   #3 one-user isolation — a second account's dial is never delivered on the
 *      first account's device channel.
 * (§7.4 shaper = rateShaper.test; §7.5/#6 gate = chatRoutesEgressSelection.test.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { WebSocket } from 'ws';
import { EgressTunnelService } from './egressTunnelService.js';
import { hashDeviceRefreshToken, type DeviceSessionRecord } from '../../../remote/store.js';
import type { DeviceSessionLookup } from './deviceSessionHelloAuthenticator.js';

const TOKEN = 'device-refresh-token-with-enough-entropy-0123456789';

function session(orgId: string, userId: string, deviceId: string): DeviceSessionRecord {
  return {
    id: `sess_${deviceId}`, familyId: `fam_${deviceId}`, orgId, userId, deviceId,
    generation: 1, parentSessionId: null, replacedBySessionId: null,
    expiresAt: '2999-01-01T00:00:00.000Z', rotatedAt: null, reuseDetectedAt: null,
    revokedAt: null, revocationReason: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A store keyed by the per-account token (so several accounts can enroll). */
function multiStore(accounts: Array<{ orgId: string; userId: string; deviceId: string; token: string }>): DeviceSessionLookup {
  const byHash = new Map(accounts.map((a) => [hashDeviceRefreshToken(a.token), a] as const));
  return {
    async getDeviceSessionByTokenHash(orgId, userId, tokenHash) {
      const a = byHash.get(tokenHash);
      if (!a || a.orgId !== orgId || a.userId !== userId) return null;
      return session(a.orgId, a.userId, a.deviceId);
    },
  };
}

let service: EgressTunnelService | null = null;
const sockets: WebSocket[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* noop */ } }
  for (const srv of servers.splice(0)) await new Promise<void>((r) => srv.close(() => r()));
  await service?.stop();
  service = null;
});

/**
 * A stub enrolled device. On each dial push it attaches its client seat to the
 * relay and, per `mode`:
 *  - 'dial': parses the gateway's binary dial-instruction, opens a REAL TCP
 *    socket to the named target, replies `dialed:ok`, and splices bytes (the
 *    real C5b behaviour, minus the SSRF guard so the test can use a loopback
 *    echo);
 *  - 'refuse': replies `dialed:{ok:false}` (tampered/blocked target);
 *  - 'silent': never replies (black-holes the dial).
 * Records every dial it is asked to perform so cross-account isolation is testable.
 */
function spawnDevice(
  opts: { controlPort: number; orgId: string; userId: string; deviceId: string; token: string; mode: 'dial' | 'refuse' | 'silent' },
): { dials: Array<{ host: string; port: number }> } {
  const dials: Array<{ host: string; port: number }> = [];
  const control = new WebSocket(`ws://127.0.0.1:${opts.controlPort}/egress-control`);
  sockets.push(control);
  control.on('open', () =>
    control.send(JSON.stringify({ kind: 'hello', orgId: opts.orgId, userId: opts.userId, deviceId: opts.deviceId, deviceToken: opts.token })),
  );
  control.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    if (msg.kind !== 'dial') return;
    dials.push({ host: String(msg.host), port: Number(msg.port) });
    const relay = new WebSocket(String(msg.relayUrl));
    sockets.push(relay);
    let provider: net.Socket | null = null;
    relay.on('open', () => relay.send(JSON.stringify({ kind: 'attach', ticket: msg.clientToken, deviceId: opts.deviceId })));
    relay.on('close', () => { try { provider?.destroy(); } catch { /* noop */ } }); // free the echo connection so close() can complete
    relay.on('message', (frame: Buffer, frameBinary: boolean) => {
      if (!frameBinary) return;
      const text = frame.toString('utf8');
      if (text.includes('"dial"')) {
        if (opts.mode === 'refuse') { relay.send(Buffer.from(JSON.stringify({ v: 1, kind: 'dialed', ok: false, error: 'blocked' })), { binary: true }); return; }
        if (opts.mode === 'silent') return;
        const target = JSON.parse(text) as { host: string; port: number };
        provider = net.connect({ host: target.host, port: target.port });
        provider.on('connect', () => relay.send(Buffer.from(JSON.stringify({ v: 1, kind: 'dialed', ok: true })), { binary: true }));
        provider.on('data', (chunk) => relay.send(chunk, { binary: true }));
        provider.on('error', () => { try { relay.close(); } catch { /* noop */ } });
        return;
      }
      provider?.write(frame); // gateway ciphertext → real provider socket
    });
  });
  return { dials };
}

function startService(store: DeviceSessionLookup): Promise<EgressTunnelService> {
  const svc = new EgressTunnelService({
    config: { enabled: true, controlPort: 0, relayPort: 0, host: '127.0.0.1' },
    store,
    ping: async () => true,
  });
  return svc.start().then(() => svc);
}

async function onceOnline(svc: EgressTunnelService, orgId: string, userId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (svc.transportForAccount(orgId, userId, 'key')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('device never came online');
}

describe('ADR-043 §7 acceptance', () => {
  it('#1 provider traffic egresses through the device to a real separate target and returns', async () => {
    // A real, SEPARATE echo server standing in for the provider endpoint.
    const echo = net.createServer((s) => s.pipe(s));
    servers.push(echo);
    const echoPort: number = await new Promise((r) => echo.listen(0, '127.0.0.1', () => {
      const a = echo.address(); r(typeof a === 'object' && a ? a.port : 0);
    }));

    service = await startService(multiStore([{ orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN }]));
    spawnDevice({ controlPort: service.boundControlPort, orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN, mode: 'dial' });
    await onceOnline(service, 'o', 'u');

    const transport = service.transportForAccount('o', 'u', 'key')!;
    // The gateway dials the provider target THROUGH the device's own network.
    const duplex = await transport.open({ host: '127.0.0.1', port: echoPort });
    const received: Buffer[] = [];
    duplex.on('data', (c: Buffer) => received.push(c));
    duplex.write(Buffer.from('provider-request-bytes'));
    await new Promise((r) => setTimeout(r, 80));
    // The bytes reached the SEPARATE echo server (via the device) and came back.
    expect(Buffer.concat(received).toString('utf8')).toBe('provider-request-bytes');
    duplex.destroy();
  });

  it('#2 a refused/tampered dial fails the open CLOSED (so the ladder takes server egress)', async () => {
    service = await startService(multiStore([{ orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN }]));
    spawnDevice({ controlPort: service.boundControlPort, orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN, mode: 'refuse' });
    await onceOnline(service, 'o', 'u');
    const transport = service.transportForAccount('o', 'u', 'key')!;
    await expect(transport.open({ host: 'api.provider.test', port: 443 })).rejects.toThrow();
  });

  it('#2b a silent (black-holed) dial fails the open within the bound, not a hang', async () => {
    service = await startService(multiStore([{ orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN }]));
    spawnDevice({ controlPort: service.boundControlPort, orgId: 'o', userId: 'u', deviceId: 'd', token: TOKEN, mode: 'silent' });
    await onceOnline(service, 'o', 'u');
    const transport = service.transportForAccount('o', 'u', 'key')!;
    const signal = AbortSignal.timeout(500);
    await expect(transport.open({ host: 'api.provider.test', port: 443 }, { signal })).rejects.toThrow();
  });

  it('#3 one-user isolation — account B never receives account A\'s dial on its device channel', async () => {
    service = await startService(
      multiStore([
        { orgId: 'orgA', userId: 'userA', deviceId: 'devA', token: `${TOKEN}-A` },
        { orgId: 'orgB', userId: 'userB', deviceId: 'devB', token: `${TOKEN}-B` },
      ]),
    );
    const a = spawnDevice({ controlPort: service.boundControlPort, orgId: 'orgA', userId: 'userA', deviceId: 'devA', token: `${TOKEN}-A`, mode: 'silent' });
    const b = spawnDevice({ controlPort: service.boundControlPort, orgId: 'orgB', userId: 'userB', deviceId: 'devB', token: `${TOKEN}-B`, mode: 'silent' });
    await onceOnline(service, 'orgA', 'userA');
    await onceOnline(service, 'orgB', 'userB');

    // Account A dials; only A's device may be asked. (Bounded so the silent dial resolves.)
    const transport = service.transportForAccount('orgA', 'userA', 'key')!;
    await transport.open({ host: 'api.provider.test', port: 443 }, { signal: AbortSignal.timeout(300) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 40));
    expect(a.dials.length).toBe(1);
    expect(b.dials.length).toBe(0); // B's channel never saw A's dial
  });
});
