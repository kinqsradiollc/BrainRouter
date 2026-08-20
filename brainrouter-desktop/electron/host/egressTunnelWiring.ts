/**
 * Host wiring for the edge egress tunnel CLIENT (ADR-043 C5). Mirrors
 * {@link ./remoteAccessWiring.ts}: it constructs the standing control-channel
 * client ({@link EgressControlClient}) plus the per-dial edge handler
 * ({@link EdgeDialHandler}), sharing the SAME enrolled-device credentials the
 * relay client uses, and dials the provider from THIS device's own network over
 * a raw TCP socket.
 *
 * Gated OFF by default: the host only starts this when `cli.remote.egressTunnel`
 * is true AND the device is enrolled. The device never terminates TLS — it relays
 * opaque ciphertext — so the raw socket carries no plaintext and no credential.
 */
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { getBrainrouterHome } from '@kinqs/brainrouter-core/storage';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { fileSecrets } from './remoteAccessWiring.js';
import { EgressControlClient, type EgressDialInstruction } from '../egressControlClient.js';
import type { BrokerSocketLike } from '../remoteAccessClient.js';
import { EdgeDialHandler, type RelaySocketLike, type TcpSocketLike } from '../egressDialHandler.js';
import type { VettedTarget } from '../edgeDialGuard.js';

/**
 * The active signed-in account's (org,user) for the control-channel hello, read
 * FRESH so an org switch is reflected on the next (re)connect. Null unless BOTH
 * ids are present — the server binds them to the device session, so a lie cannot
 * authenticate.
 */
export function resolveActiveIdentity(config: unknown): { orgId: string; userId: string } | null {
  const account = (config as { cli?: { account?: { orgId?: unknown; userId?: unknown } } }).cli?.account;
  const orgId = typeof account?.orgId === 'string' ? account.orgId : null;
  const userId = typeof account?.userId === 'string' ? account.userId : null;
  return orgId && userId ? { orgId, userId } : null;
}

/**
 * The gateway's egress control-channel base — `cli.remote.egressControlUrl`
 * (`wss://…`, or `ws://` only for loopback). Distinct from the mobile-relay
 * broker (`cli.remote.relayUrl`): the control channel lives on the gateway.
 */
export function resolveEgressControlUrl(config: unknown): string | null {
  const raw = (config as { cli?: { remote?: { egressControlUrl?: unknown } } }).cli?.remote?.egressControlUrl;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    // Credential material must not cross the network in cleartext (CWE-319).
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && loopback)) return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** True only when the operator has opted this device into client-tunnel egress. */
export function egressTunnelEnabled(config: unknown): boolean {
  return (config as { cli?: { remote?: { egressTunnel?: unknown } } }).cli?.remote?.egressTunnel === true;
}

/**
 * Raw-TCP dial to the PINNED IP (`target.address`), never the hostname — dialing
 * the hostname would re-resolve DNS and defeat the SSRF guard's pin (TOCTOU
 * rebind). The device relays ciphertext only; there is no TLS here.
 */
export function netTcpConnect(target: VettedTarget): TcpSocketLike {
  const socket = net.connect({ host: target.address, port: target.port });
  return {
    write: (data) => {
      socket.write(data);
    },
    end: () => {
      socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
    on: (event, listener) => {
      socket.on(event, listener as (...args: unknown[]) => void);
    },
  };
}

export interface EgressTunnelWiringDeps {
  home?: string;
  /** Injectable for tests; production reads config.json via loadConfig. */
  loadConfigFn?: () => unknown;
  controlWsFactory?: (url: string) => BrokerSocketLike;
  relayWsFactory?: (url: string) => RelaySocketLike;
  tcpConnect?: (target: VettedTarget) => TcpSocketLike;
}

/**
 * Assemble the egress tunnel client. The returned {@link EgressControlClient} is
 * idempotently `start()`/`stop()`-able; it self-defers connecting until the
 * device is enrolled and an identity + control URL are configured, so the host
 * may start it eagerly once gated.
 */
export function createEgressTunnelClient(deps: EgressTunnelWiringDeps = {}): EgressControlClient {
  const home = deps.home ?? getBrainrouterHome();
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const secrets = fileSecrets(path.join(home, 'mobile', 'remote-device.json'));
  const controlWsFactory =
    deps.controlWsFactory ?? ((url: string) => new WebSocket(url) as unknown as BrokerSocketLike);
  const relayWsFactory =
    deps.relayWsFactory ?? ((url: string) => new WebSocket(url) as unknown as RelaySocketLike);
  const tcpConnect = deps.tcpConnect ?? netTcpConnect;

  const handler = new EdgeDialHandler({
    relayWsFactory,
    tcpConnect,
    deviceId: () => secrets.get('remote.deviceId'),
  });

  return new EgressControlClient({
    relayUrl: () => resolveEgressControlUrl(loadConfigFn()),
    identity: () => resolveActiveIdentity(loadConfigFn()),
    secrets,
    wsFactory: controlWsFactory,
    onDial: (instruction: EgressDialInstruction) => handler.handle(instruction),
  });
}
