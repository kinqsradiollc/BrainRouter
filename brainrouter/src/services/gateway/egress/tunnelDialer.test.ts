import { describe, expect, it } from 'vitest';
import type { Duplex } from 'node:stream';
import type { ValidatedUpstreamTarget } from '@kinqs/brainrouter-core/provider';
import { createTunnelConnector, createTunnelDialer } from './tunnelDialer.js';
import { dialTargetFromValidated, type EgressDialTarget, type EgressTunnelTransport } from './tunnelTransport.js';

function validated(urlStr: string): ValidatedUpstreamTarget {
  const url = new URL(urlStr);
  return { url, hostname: url.hostname, addresses: [{ address: '203.0.113.7', family: 4 }], allowlisted: true };
}

/** Invoke the undici connector once and resolve with the (error | null) it reports. */
function connect(
  transport: EgressTunnelTransport,
  target: ValidatedUpstreamTarget,
  opts: { hostname: string; protocol: string; port: string; servername?: string },
): Promise<Error | null> {
  const connector = createTunnelConnector(transport, target);
  return new Promise<Error | null>((resolve) => {
    connector(opts, (err, _socket) => resolve(err));
  });
}

describe('dialTargetFromValidated', () => {
  it('derives host + default 443 for https', () => {
    expect(dialTargetFromValidated(validated('https://api.provider.test/v1/chat'))).toEqual({
      host: 'api.provider.test',
      port: 443,
    });
  });

  it('honours an explicit port', () => {
    expect(dialTargetFromValidated(validated('https://api.provider.test:8443/v1'))).toEqual({
      host: 'api.provider.test',
      port: 8443,
    });
  });

  it('derives default 80 for http', () => {
    expect(dialTargetFromValidated(validated('http://local.test/v1'))).toEqual({
      host: 'local.test',
      port: 80,
    });
  });
});

describe('createTunnelConnector — credential-blind gate (ADR-043 D1)', () => {
  it('refuses a non-https target and never touches the edge', async () => {
    let opened = false;
    const transport: EgressTunnelTransport = {
      open: () => {
        opened = true;
        return Promise.reject(new Error('the edge must not be opened for a plaintext target'));
      },
    };
    const err = await connect(transport, validated('http://api.provider.test/v1'), {
      hostname: 'api.provider.test',
      protocol: 'http:',
      port: '80',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/plaintext|https/i);
    expect(opened).toBe(false); // fail closed BEFORE the credential could be exposed
  });
});

describe('createTunnelConnector — edge failures fall back (ADR-043 D4)', () => {
  it('propagates an edge-open rejection as a connect error', async () => {
    const transport: EgressTunnelTransport = { open: () => Promise.reject(new Error('no edge channel')) };
    const err = await connect(transport, validated('https://api.provider.test/v1'), {
      hostname: 'api.provider.test',
      protocol: 'https:',
      port: '443',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/no edge channel/);
  });

  it('requests the tunnel for the exact validated host:port', async () => {
    const seen: EgressDialTarget[] = [];
    const transport: EgressTunnelTransport = {
      open: (t: EgressDialTarget): Promise<Duplex> => {
        seen.push(t);
        return Promise.reject(new Error('stop after capture'));
      },
    };
    await connect(transport, validated('https://api.provider.test:8443/v1/chat'), {
      hostname: 'api.provider.test',
      protocol: 'https:',
      port: '8443',
    });
    expect(seen).toEqual([{ host: 'api.provider.test', port: 8443 }]);
  });
});

describe('createTunnelDialer', () => {
  it('returns a disposable dispatcher handle', async () => {
    const transport: EgressTunnelTransport = { open: () => Promise.reject(new Error('unused')) };
    const handle = createTunnelDialer(transport)(validated('https://api.provider.test/v1'));
    expect(handle.dispatcher).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await expect(handle.close?.()).resolves.not.toThrow();
  });
});
