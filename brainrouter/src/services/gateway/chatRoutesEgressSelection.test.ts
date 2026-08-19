import { describe, expect, it } from 'vitest';
import {
  selectUpstreamForRequest,
  type GatewayDataPlaneOptions,
  type GatewayEgressSelection,
} from './chatRoutes.js';
import type { GatewayAuthContext } from './auth.js';
import type { ResolvedProviderConfig } from '../../providers/types.js';
import type { EgressTunnelTransport } from './egress/tunnelTransport.js';
import type { SafeUpstreamFetchOptions } from './upstreamPolicy.js';

const userAuth = {
  credentialType: 'jwt',
  principalType: 'user',
  userId: 'u1',
  orgId: 'o1',
  role: 'member',
  scopes: [],
} as unknown as GatewayAuthContext;

const serviceAuth = {
  credentialType: 'internal_service',
  principalType: 'service',
  servicePrincipalId: 's1',
  orgId: 'o1',
  scopes: [],
} as unknown as GatewayAuthContext;

const provider = {
  kind: 'llm',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'k',
  model: 'm',
  models: [],
  extra: {},
  source: 'db',
} as unknown as ResolvedProviderConfig;

const fakeTransport = {} as EgressTunnelTransport;
const clientTunnel = () => ({ egressMode: 'client-tunnel' as const, egressCapabilities: { clientTunnel: true } });
const serverOnly = () => ({ egressMode: 'server' as const, egressCapabilities: {} });

function egress(over: Partial<GatewayEgressSelection> = {}): GatewayEgressSelection & {
  calls: { transport: number; optIn: number };
} {
  const calls = { transport: 0, optIn: 0 };
  return {
    calls,
    transportForAccount: () => {
      calls.transport += 1;
      return fakeTransport;
    },
    orgOptIn: async () => {
      calls.optIn += 1;
      return true;
    },
    ...over,
  };
}

const base: SafeUpstreamFetchOptions = {};

describe('selectUpstreamForRequest (C6b-2 dialer gate)', () => {
  it('returns the shared upstream options unchanged when the tunnel is disabled (no egress)', async () => {
    const options: GatewayDataPlaneOptions = { upstream: base };
    const result = await selectUpstreamForRequest(options, userAuth, provider, clientTunnel);
    expect(result).toBe(base); // same reference — never copied or mutated
  });

  it('skips the tunnel for a service principal (no device)', async () => {
    const eg = egress();
    const options: GatewayDataPlaneOptions = { upstream: base, egress: eg };
    const result = await selectUpstreamForRequest(options, serviceAuth, provider, clientTunnel);
    expect(result).toBe(base);
    expect(eg.calls.transport).toBe(0);
  });

  it('skips the tunnel when the provider does not declare clientTunnel', async () => {
    const eg = egress();
    const options: GatewayDataPlaneOptions = { upstream: base, egress: eg };
    const result = await selectUpstreamForRequest(options, userAuth, provider, serverOnly);
    expect(result).toBe(base);
    expect(eg.calls.transport).toBe(0); // never even resolved a device
  });

  it('falls back when no device is online (transport undefined)', async () => {
    const eg = egress({ transportForAccount: () => undefined });
    const options: GatewayDataPlaneOptions = { upstream: base, egress: eg };
    const result = await selectUpstreamForRequest(options, userAuth, provider, clientTunnel);
    expect(result).toBe(base);
    expect(eg.calls.optIn).toBe(0); // no consent DB read when there is no device
  });

  it('falls back when the org has not opted in', async () => {
    const eg = egress({ orgOptIn: async () => false });
    const options: GatewayDataPlaneOptions = { upstream: base, egress: eg };
    const result = await selectUpstreamForRequest(options, userAuth, provider, clientTunnel);
    expect(result).toBe(base);
  });

  it('selects the edge dialer when eligible: clientTunnel + online device + org opt-in', async () => {
    const eg = egress();
    const options: GatewayDataPlaneOptions = { upstream: base, egress: eg };
    const result = await selectUpstreamForRequest(options, userAuth, provider, clientTunnel);
    expect(result).not.toBe(base); // a fresh per-request copy
    expect(typeof result?.dispatcherFactory).toBe('function');
    expect(eg.calls.transport).toBe(1);
    expect(eg.calls.optIn).toBe(1);
  });
});
