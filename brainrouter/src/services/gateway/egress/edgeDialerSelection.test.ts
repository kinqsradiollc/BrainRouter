import { describe, expect, it, vi } from 'vitest';
import type { Duplex } from 'node:stream';
import type { buildConnector } from 'undici';
import type { ValidatedUpstreamTarget } from '@kinqs/brainrouter-core/provider';
import { directDialer } from '../upstreamPolicy.js';
import type { EgressTunnelTransport, EgressDialTarget } from './tunnelTransport.js';
import { createFallbackConnector, selectEdgeDialer, type EdgeDialerSelectionInput } from './edgeDialerSelection.js';

type Connector = buildConnector.connector;

// A transport that must never be opened in the dark/fallback branches — opening it
// would prove selection wrongly chose the tunnel when it had no right to.
const explodingTransport: EgressTunnelTransport = {
  open: () => {
    throw new Error('transport.open must not be reached');
  },
};

// A transport whose channel is genuinely open (used for the honoured branch).
function liveTransport(): EgressTunnelTransport {
  return { open: (_t: EgressDialTarget) => Promise.resolve({} as unknown as Duplex) };
}

const CAPABLE = { clientTunnel: true } as const;

function pick(over: Partial<EdgeDialerSelectionInput>): ReturnType<typeof selectEdgeDialer> {
  return selectEdgeDialer({ ...over });
}

describe('selectEdgeDialer — dark by default (ADR-043 S4a)', () => {
  it('returns directDialer when no mode is set', () => {
    expect(pick({})).toBe(directDialer);
  });

  it('returns directDialer for explicit server mode', () => {
    expect(pick({ egressMode: 'server', egressCapabilities: CAPABLE, orgOptIn: true, transport: explodingTransport }))
      .toBe(directDialer);
  });

  it('refuses the tunnel when the adapter declares no clientTunnel capability', () => {
    expect(pick({ egressMode: 'client-tunnel', orgOptIn: true, transport: explodingTransport }))
      .toBe(directDialer);
    expect(pick({ egressMode: 'client-tunnel', egressCapabilities: { clientTunnel: false }, orgOptIn: true, transport: explodingTransport }))
      .toBe(directDialer);
  });

  it('refuses the tunnel when the org has not opted in (D2 consent gate)', () => {
    expect(pick({ egressMode: 'client-tunnel', egressCapabilities: CAPABLE, orgOptIn: false, transport: explodingTransport }))
      .toBe(directDialer);
    expect(pick({ egressMode: 'client-tunnel', egressCapabilities: CAPABLE, transport: explodingTransport }))
      .toBe(directDialer);
  });

  it('refuses the tunnel when no live edge transport is present', () => {
    expect(pick({ egressMode: 'client-tunnel', egressCapabilities: CAPABLE, orgOptIn: true }))
      .toBe(directDialer);
  });

  it('treats vended-token as a non-dial path (server egress for the gateway)', () => {
    expect(pick({ egressMode: 'vended-token', egressCapabilities: { vendableToken: true }, orgOptIn: true, transport: explodingTransport }))
      .toBe(directDialer);
  });

  it('auto without clientTunnel capability stays on server egress', () => {
    expect(pick({ egressMode: 'auto', egressCapabilities: { vendableToken: true }, orgOptIn: true, transport: explodingTransport }))
      .toBe(directDialer);
  });
});

describe('selectEdgeDialer — the honoured tunnel branch', () => {
  it('returns a distinct tunnel dialer when capability + opt-in + transport all hold', () => {
    const dialer = pick({ egressMode: 'client-tunnel', egressCapabilities: CAPABLE, orgOptIn: true, transport: liveTransport() });
    expect(dialer).not.toBe(directDialer);
    const target = { url: new URL('https://api.example.com'), hostname: 'api.example.com' } as unknown as ValidatedUpstreamTarget;
    const handle = dialer(target);
    expect(handle.dispatcher).toBeTruthy();
    expect(typeof handle.close).toBe('function');
    void handle.close?.();
  });

  it('auto resolves to the tunnel when the client-tunnel capability is present + opted in', () => {
    const dialer = pick({ egressMode: 'auto', egressCapabilities: CAPABLE, orgOptIn: true, transport: liveTransport() });
    expect(dialer).not.toBe(directDialer);
  });
});

describe('createFallbackConnector — the D4 ladder', () => {
  const opts = {} as Parameters<Connector>[0];
  const primarySocket = { id: 'primary' } as never;
  const fallbackSocket = { id: 'fallback' } as never;

  it('returns the primary socket and never touches the fallback on success', () => {
    const fallback = vi.fn<Parameters<Connector>, void>((_o, cb) => cb(null, fallbackSocket));
    const onFallback = vi.fn<[Error], void>();
    const connector = createFallbackConnector((_o, cb) => cb(null, primarySocket), fallback, onFallback);
    const seen = vi.fn();
    connector(opts, (err, socket) => seen(err, socket));
    expect(seen).toHaveBeenCalledWith(null, primarySocket);
    expect(fallback).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('drops to the fallback socket and reports the reason when the primary errors', () => {
    const boom = new Error('no edge channel');
    const onFallback = vi.fn<[Error], void>();
    const connector = createFallbackConnector(
      (_o, cb) => cb(boom, null),
      (_o, cb) => cb(null, fallbackSocket),
      onFallback,
    );
    const seen = vi.fn();
    connector(opts, (err, socket) => seen(err, socket));
    expect(seen).toHaveBeenCalledWith(null, fallbackSocket);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0][0]).toBe(boom);
  });

  it('treats a primary that yields no socket as a failure and falls back', () => {
    const onFallback = vi.fn<[Error], void>();
    // A connector that violates undici's union (null,null) — createFallbackConnector
    // must still treat "no error, no socket" as a failure, so we force the shape.
    const noSocketPrimary: Connector = (_o, cb) => (cb as unknown as (e: null, s: null) => void)(null, null);
    const connector = createFallbackConnector(
      noSocketPrimary,
      (_o, cb) => cb(null, fallbackSocket),
      onFallback,
    );
    const seen = vi.fn();
    connector(opts, (err, socket) => seen(err, socket));
    expect(seen).toHaveBeenCalledWith(null, fallbackSocket);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('propagates a fallback failure unchanged (both legs down = fail closed)', () => {
    const fallbackErr = new Error('server egress also failed');
    const connector = createFallbackConnector(
      (_o, cb) => cb(new Error('tunnel down'), null),
      (_o, cb) => cb(fallbackErr, null),
    );
    const seen = vi.fn();
    connector(opts, (err, socket) => seen(err, socket));
    expect(seen).toHaveBeenCalledWith(fallbackErr, null);
  });
});
