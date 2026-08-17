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

/**
 * Default bound on a tunnel connect. Matches undici's own `connectTimeout` default
 * (10s), which a FUNCTION-style connector does NOT inherit — so the ladder must
 * impose its own, or a dead (not erroring) edge would hang the request forever.
 */
export const DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS = 10_000;

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
  /** Max time to wait for the tunnel to connect before dropping to server egress (D4). */
  readonly tunnelConnectTimeoutMs?: number;
  /** Observability hook fired once per connection that drops from tunnel to server egress (D4). */
  readonly onFallback?: (reason: Error) => void;
}

export interface FallbackConnectorOptions {
  /** Fired once per connection that drops from tunnel to server egress. */
  readonly onFallback?: (reason: Error) => void;
  /** Bound on the primary (tunnel) leg; on expiry the ladder drops to `fallback`. */
  readonly timeoutMs?: number;
  /** Fired when the timeout expires, BEFORE falling back — lets the caller abort the tunnel attempt. */
  readonly onTimeout?: () => void;
}

type ConnectCallback = Parameters<buildConnector.connector>[1];
type ConnectedSocket = NonNullable<Parameters<ConnectCallback>[1]>;

/**
 * ADR-043 D4 — the fallback ladder as a CONNECT-time composition: try `primary`;
 * if it errors, yields no socket, OR does not connect within `timeoutMs`,
 * transparently connect via `fallback`. Because undici invokes the connector
 * BEFORE writing any request bytes, dropping from the tunnel to server egress
 * needs no body replay — undici only ever sees the surviving socket, so a missing,
 * broken, or DEAD edge channel becomes a transparent server-egress request instead
 * of a failed one ("never a cliff").
 *
 * The timeout is load-bearing, not defensive polish: a function-style connector
 * does not inherit undici's `connectTimeout`, and `createTunnelConnector` awaits
 * `transport.open()` with no bound of its own — so a device that accepts the tunnel
 * request and then sleeps/black-holes settles NEITHER callback. Without this timer
 * the request would hang forever, defeating D4 exactly on the commonest edge
 * failure (dead, not erroring). `onTimeout` lets the caller abort the orphaned
 * tunnel; a late tunnel socket that arrives after we've fallen back is destroyed.
 *
 * `onFallback` / `onTimeout` are caller telemetry and are isolated in try/catch:
 * a throwing hook must never suppress the safety-net leg.
 */
export function createFallbackConnector(
  primary: buildConnector.connector,
  fallback: buildConnector.connector,
  options: FallbackConnectorOptions = {},
): buildConnector.connector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS;
  return (opts, callback) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const drop = (reason: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        options.onFallback?.(reason);
      } catch {
        // A telemetry/consent hook must never suppress the fallback leg.
      }
      fallback(opts, callback);
    };
    const succeed = (socket: ConnectedSocket): void => {
      if (settled) {
        // The tunnel connected AFTER we already fell back — discard the orphan so
        // its file descriptor / device duplex does not leak.
        (socket as unknown as { destroy?: () => void }).destroy?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(null, socket);
    };

    timer = setTimeout(() => {
      try {
        options.onTimeout?.();
      } catch {
        // Aborting the orphaned tunnel is best-effort and must not sink the fallback.
      }
      drop(new Error(`egress tunnel connect exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    primary(opts, (err, socket) => {
      if (!err && socket) succeed(socket);
      else drop(err ?? new Error('egress tunnel produced no socket'));
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
 * bounded connect-time fallback to DNS-pinned server egress (same pinned lookup as
 * `directDialer`, so the SSRF guard is identical on the fallback leg). Each connect
 * attempt gets its own AbortController so a timed-out tunnel is torn down rather
 * than left dangling.
 *
 * `'vended-token'` is NOT a gateway-dial path (the client calls the vendor itself,
 * S5), so for any residual server-side dial it resolves to `directDialer`.
 */
export function selectEdgeDialer(input: EdgeDialerSelectionInput): EdgeDialer {
  if (!tunnelPermitted(input)) return directDialer;
  const { transport, tunnelOptions, onFallback } = input;
  const timeoutMs = input.tunnelConnectTimeoutMs ?? DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS;
  return (target: ValidatedUpstreamTarget): UpstreamDispatcherHandle => {
    const directConnector = buildConnector({ lookup: createPinnedLookup(target) as never });
    const connect: buildConnector.connector = (opts, callback) => {
      // Per connection attempt: an AbortController so a connect timeout tears the
      // orphaned tunnel down instead of leaving the device channel half-open.
      const abort = new AbortController();
      const tunnelConnector = createTunnelConnector(transport, target, { ...tunnelOptions, signal: abort.signal });
      const composite = createFallbackConnector(tunnelConnector, directConnector, {
        onFallback,
        timeoutMs,
        onTimeout: () => abort.abort(),
      });
      composite(opts, callback);
    };
    const dispatcher = new Agent({ connect });
    return { dispatcher, close: () => dispatcher.close() };
  };
}
