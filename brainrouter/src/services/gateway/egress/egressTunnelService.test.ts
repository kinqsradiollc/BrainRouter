import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EgressTunnelService } from './egressTunnelService.js';
import { hashDeviceRefreshToken, type DeviceSessionRecord } from '../../../remote/store.js';
import type { DeviceSessionLookup } from './deviceSessionHelloAuthenticator.js';
import type { EgressSessionIdentity } from './egressTicket.js';

const ORG = 'org_1';
const USER = 'user_1';
const DEVICE = 'device_abc';
const TOKEN = 'device-refresh-token-with-enough-entropy-0123456789';
const TOKEN_HASH = hashDeviceRefreshToken(TOKEN);

const identity: EgressSessionIdentity = {
  orgId: ORG,
  userId: USER,
  clientDeviceId: DEVICE,
  upstreamKeyId: 'key_1',
};

function liveSession(): DeviceSessionRecord {
  return {
    id: 'sess_1',
    familyId: 'fam_1',
    orgId: ORG,
    userId: USER,
    deviceId: DEVICE,
    generation: 1,
    parentSessionId: null,
    replacedBySessionId: null,
    expiresAt: '2999-01-01T00:00:00.000Z',
    rotatedAt: null,
    reuseDetectedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const store: DeviceSessionLookup = {
  async getDeviceSessionByTokenHash(orgId, userId, tokenHash) {
    if (orgId !== ORG || userId !== USER || tokenHash !== TOKEN_HASH) return null;
    return liveSession();
  },
};

let service: EgressTunnelService | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  await service?.stop();
  service = null;
});

/**
 * A stub enrolled device: authenticates on the control channel, and on each dial
 * push attaches its client seat to the relay, acks `dialed`, then echoes bytes —
 * i.e. the minimal C5a+C5b behaviour needed to complete a splice.
 */
function spawnStubDevice(controlPort: number): Promise<void> {
  return new Promise((resolveReady) => {
    const control = new WebSocket(`ws://127.0.0.1:${controlPort}/egress-control`);
    sockets.push(control);
    control.on('open', () => {
      control.send(JSON.stringify({ kind: 'hello', orgId: ORG, userId: USER, deviceId: DEVICE, deviceToken: TOKEN }));
    });
    control.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (msg.kind === 'ready') {
        resolveReady();
        return;
      }
      if (msg.kind === 'dial') {
        const relay = new WebSocket(String(msg.relayUrl));
        sockets.push(relay);
        relay.on('open', () => {
          relay.send(JSON.stringify({ kind: 'attach', ticket: msg.clientToken, deviceId: DEVICE }));
        });
        relay.on('message', (frame: Buffer, frameBinary: boolean) => {
          if (!frameBinary) return; // relay control frames
          const text = frame.toString('utf8');
          if (text.includes('"dial"')) {
            relay.send(Buffer.from(JSON.stringify({ v: 1, kind: 'dialed', ok: true })), { binary: true });
            return;
          }
          relay.send(frame, { binary: true }); // echo provider ciphertext
        });
      }
    });
  });
}

describe('EgressTunnelService (C6a)', () => {
  it('stays dark when disabled: no listeners, no transport', async () => {
    service = new EgressTunnelService({ config: { enabled: false, controlPort: 0, relayPort: 0 }, store, ping: async () => true });
    await service.start();
    expect(service.running).toBe(false);
    expect(service.transportForUser(identity)).toBeUndefined();
  });

  it('returns no transport when the user device is not online', async () => {
    service = new EgressTunnelService({
      config: { enabled: true, controlPort: 0, relayPort: 0, host: '127.0.0.1' },
      store,
      ping: async () => true,
    });
    await service.start();
    expect(service.running).toBe(true);
    expect(service.transportForUser(identity)).toBeUndefined();
  });

  it('opens a live tunnel to an online device end-to-end (auth → dial push → splice)', async () => {
    service = new EgressTunnelService({
      config: { enabled: true, controlPort: 0, relayPort: 0, host: '127.0.0.1' },
      store,
      ping: async () => true,
    });
    await service.start();

    await spawnStubDevice(service.boundControlPort); // device authenticates + goes online
    const transport = service.transportForUser(identity);
    expect(transport).toBeDefined();

    const duplex = await transport!.open({ host: 'api.provider.test', port: 443 });
    const received: Buffer[] = [];
    duplex.on('data', (chunk: Buffer) => received.push(chunk));
    duplex.write(Buffer.from('tls-record-1'));
    await new Promise((r) => setTimeout(r, 60));
    expect(Buffer.concat(received).toString('utf8')).toBe('tls-record-1');
    duplex.destroy();
  });

  it('transportForAccount resolves the online device from (org,user) alone', async () => {
    service = new EgressTunnelService({
      config: { enabled: true, controlPort: 0, relayPort: 0, host: '127.0.0.1' },
      store,
      ping: async () => true,
    });
    await service.start();
    // No device online yet → no transport.
    expect(service.transportForAccount(ORG, USER, 'key_1')).toBeUndefined();

    await spawnStubDevice(service.boundControlPort);
    const transport = service.transportForAccount(ORG, USER, 'key_1');
    expect(transport).toBeDefined();

    const duplex = await transport!.open({ host: 'api.provider.test', port: 443 });
    const received: Buffer[] = [];
    duplex.on('data', (chunk: Buffer) => received.push(chunk));
    duplex.write(Buffer.from('acct-bytes'));
    await new Promise((r) => setTimeout(r, 60));
    expect(Buffer.concat(received).toString('utf8')).toBe('acct-bytes');
    duplex.destroy();
  });
});
