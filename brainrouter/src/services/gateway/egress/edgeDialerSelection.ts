import { Agent, buildConnector } from 'undici';
import {
  createPinnedLookup,
  type ValidatedUpstreamTarget,
} from '@kinqs/brainrouter-core/provider';
import {
  directDialer,
  type EdgeDialer,
  type UpstreamDispatcherHandle,
} from '../upstreamPolicy.js';
import { createTunnelConnector, type TunnelDialerOptions } from './tunnelDialer.js';
import type { EgressTunnelTransport } from './tunnelTransport.js';

/** ADR-043 D3 — the per-provider egress modes (mirrors `ProviderDefinition.egressMode`). */
export type EgressMode = 'server' | 'client-tunnel' | 'vended-token' | 'auto';

export interface EdgeDialerSelectionInput {
  /** The provider's configured mode. Omitted / `'server'` ⇒ server egress (today). */
  readonly egressMode?: EgressMode;
  /** What the provider ADAPTER declares it can actually do (`ProviderDefinition.egressCapabilities`). */
  readonly egressCapabilities?: { vendableToken?: boolean; clientTunnel?: boolean };
  /** A live byte channel to the requesting user's edge, or undefined when none is open. */
  readonly transport?: EgressTunnelTransport;
  /** True only when a per-org policy has opted this org into non-server egress (D2 consent). */
  readonly orgOptIn?: boolean;
  /** TLS overrides forwarded to the tunnel connector (pinning, custom CA). */
  readonly tunnelOptions?: TunnelDialerOptions;
  /** Observability hook fired once per connection that drops from tunnel to server egress (D4). */
  readonly onFallback?: (reason: Error) => void;
}

/**
 * ADR-043 D4 — the fallback ladder as a CONNECT-time composition: try `primary`;
 * if it errors (or yields no socket), transparently connect via `fallback`.
 *
 * Because undici invokes the connector BEFORE writing any request bytes, dropping
 * from the tunnel to server egress needs no body replay — undici only ever sees
 * the surviving socket, so a missing or broken edge channel becomes a transparent
 * server-egress request instead of a failed one ("never a cliff"). The drop is not
 * silent to operators: `onFallback` fires with the underlying reason so S4b can
 * telemeter it and the consent UI can show that privacy was downgraded.
 */
export function createFallbackConnector(
  primary: buildConnector.connector,
  fallback: buildConnector.connector,
  onFallback?: (reason: Error) => void,
): buildConnector.connector {
  return (opts, callback) => {
    primary(opts, (err, socket) => {
      if (!err && socket) {
        callback(null, socket);
        return;
      }
      onFallback?.(err ?? new Error('egress tunnel produced no socket'));
      fallback(opts, callback);
    });
  };
}

/**
 * A non-server mode may open a tunnel only when ALL THREE hold (the contract
 * `ProviderDefinition.egressMode` documents): the adapter declares the capability,
 * the org has opted in, and a live edge transport is present. Any missing leg
 * means server egress — this is what lets the feature ship dark.
 */
function tunnelPermitted(input: EdgeDialerSelectionInput): input is EdgeDialerSelectionInput & {
  transport: EgressTunnelTransport;
} {
  if (!input.transport || input.orgOptIn !== true) return false;
  if (input.egressCapabilities?.clientTunnel !== true) return false;
  return input.egressMode === 'client-tunnel' || input.egressMode === 'auto';
}

/**
 * ADR-043 S4 (D2/D3/D4/D6) — resolve the {@link EdgeDialer} for one upstream
 * request. Ships DARK: unless the provider declares `clientTunnel` capability, the
 * org has opted in, and a live edge transport is present, this returns
 * `directDialer` — byte-identical to today's server egress. When all three hold it
 * returns a tunnel dialer that routes the connection through the user's edge with a
 * connect-time fallback to DNS-pinned server egress (same pinned lookup as
 * `directDialer`, so the SSRF guard is identical on the fallback leg).
 *
 * `'vended-token'` is NOT a gateway-dial path (the client calls the vendor itself,
 * S5), so for any residual server-side dial it resolves to `directDialer`.
 */
export function selectEdgeDialer(input: EdgeDialerSelectionInput): EdgeDialer {
  if (!tunnelPermitted(input)) return directDialer;
  const { transport, tunnelOptions, onFallback } = input;
  return (target: ValidatedUpstreamTarget): UpstreamDispatcherHandle => {
    const tunnelConnector = createTunnelConnector(transport, target, tunnelOptions);
    const directConnector = buildConnector({ lookup: createPinnedLookup(target) as never });
    const connector = createFallbackConnector(tunnelConnector, directConnector, onFallback);
    const dispatcher = new Agent({ connect: connector });
    return { dispatcher, close: () => dispatcher.close() };
  };
}
