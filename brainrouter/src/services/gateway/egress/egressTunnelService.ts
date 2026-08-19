import type { WebSocket } from 'ws';
import { EgressControlChannel, type EdgeIdentity } from './egressControlChannel.js';
import { EgressTicketRegistry, type EgressSessionIdentity } from './egressTicket.js';
import { createEgressRelayServer } from './egressRelayServer.js';
import { createRelayEgressChannelOpener } from './relayChannelOpener.js';
import { createEdgePushDelivery } from './edgePushDelivery.js';
import { FramedEgressTransport } from './framedTransport.js';
import {
  createDeviceSessionHelloAuthenticator,
  type DeviceSessionLookup,
} from './deviceSessionHelloAuthenticator.js';
import type { EgressTunnelTransport } from './tunnelTransport.js';

export interface EgressTunnelServiceConfig {
  /** Master switch — the tunnel is OFF (fully dark) unless this is true. */
  readonly enabled: boolean;
  /** Port for the device-facing control channel (`/egress-control`). */
  readonly controlPort: number;
  /** Port for the opaque splice relay (`/egress-relay`). */
  readonly relayPort: number;
  /** Bind host for both listeners. */
  readonly host?: string;
  /**
   * Public WS URL of the relay that BOTH the server's origin seat and the remote
   * device connect to (e.g. `wss://relay.example.com/egress-relay`). Defaults to
   * `ws://<host>:<relayPort>/egress-relay` for single-host / dev.
   */
  readonly relayPublicUrl?: string;
}

export interface EgressTunnelServiceDeps {
  readonly config: EgressTunnelServiceConfig;
  /** Device-session lookup for the control-channel hello authenticator. */
  readonly store: DeviceSessionLookup;
  /** DB readiness probe for the relay. */
  readonly ping: () => Promise<boolean>;
  readonly now?: () => number;
  /** Injectable for tests; production opens a real `ws` WebSocket. */
  readonly wsFactory?: (url: string) => WebSocket;
}

/**
 * ADR-043 S3b (C6a) — the gateway-boot composition of the edge egress tunnel. It
 * stands up the device-facing control channel and the opaque splice relay (both
 * DARK unless `config.enabled`), and hands the chat route a `transportForUser`
 * that yields a live {@link EgressTunnelTransport} ONLY when that user's enrolled
 * device is currently online.
 *
 * Single-node / in-process: one {@link EgressTicketRegistry} is shared between
 * the minting opener and the relay's control plane, so a ticket minted here can
 * only be redeemed on this instance (promoting the registry to a shared store is
 * the documented multi-node follow-up). Nothing changes request handling until a
 * provider declares `clientTunnel`, an org opts in, AND a device is online — this
 * service only makes a transport *available* to the dialer selection.
 */
export class EgressTunnelService {
  readonly #deps: EgressTunnelServiceDeps;
  #registry: EgressTicketRegistry | null = null;
  #control: EgressControlChannel | null = null;
  #relay: ReturnType<typeof createEgressRelayServer> | null = null;
  #relayUrl = '';
  #boundControlPort = 0;
  #boundRelayPort = 0;

  constructor(deps: EgressTunnelServiceDeps) {
    this.#deps = deps;
  }

  get enabled(): boolean {
    return this.#deps.config.enabled;
  }

  /** Actual bound port of the device-facing control channel (0 until started). */
  get boundControlPort(): number {
    return this.#boundControlPort;
  }

  /** Actual bound port of the splice relay (0 until started). */
  get boundRelayPort(): number {
    return this.#boundRelayPort;
  }

  /** Stand up the control + relay listeners. No-op (stays dark) when disabled. */
  async start(): Promise<void> {
    const { config } = this.#deps;
    if (!config.enabled || this.#control) return;
    const host = config.host ?? '0.0.0.0';
    this.#registry = new EgressTicketRegistry(this.#deps.now ? { now: this.#deps.now } : {});
    this.#control = new EgressControlChannel({
      authenticate: createDeviceSessionHelloAuthenticator({ store: this.#deps.store, now: this.#deps.now }),
      now: this.#deps.now,
    });
    this.#relay = createEgressRelayServer({
      registry: this.#registry,
      ping: this.#deps.ping,
      now: this.#deps.now,
    });
    this.#boundControlPort = await this.#control.listen(config.controlPort, host);
    this.#boundRelayPort = await this.#relay.listen(config.relayPort, host);
    const reachableHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    this.#relayUrl = config.relayPublicUrl ?? `ws://${reachableHost}:${this.#boundRelayPort}/egress-relay`;
  }

  /** True once the control channel is up. */
  get running(): boolean {
    return this.#control !== null;
  }

  /**
   * A live tunnel transport for THIS user's dial, or `undefined` when the tunnel
   * is disabled/not running or the user's enrolled device is not currently online
   * — in which case the dialer selection falls back to direct server egress.
   */
  transportForUser(identity: EgressSessionIdentity): EgressTunnelTransport | undefined {
    const control = this.#control;
    const registry = this.#registry;
    if (!control || !registry) return undefined;
    const edge: EdgeIdentity = {
      orgId: identity.orgId,
      userId: identity.userId,
      deviceId: identity.clientDeviceId,
    };
    if (!control.isOnline(edge)) return undefined;
    const opener = createRelayEgressChannelOpener({
      registry,
      identityFor: () => identity,
      egressRelayUrl: this.#relayUrl,
      pushDialToEdge: createEdgePushDelivery(control, identity),
      wsFactory: this.#deps.wsFactory,
    });
    return new FramedEgressTransport(opener);
  }

  /**
   * Resolve a live transport for an ACCOUNT (org,user) + upstream key, picking one
   * of that user's currently-online devices to relay through. Returns `undefined`
   * when the tunnel is off or the user has no online device (→ direct egress).
   * This is the form the chat route calls, since a request knows only (org,user).
   */
  transportForAccount(orgId: string, userId: string, upstreamKeyId: string): EgressTunnelTransport | undefined {
    const control = this.#control;
    if (!control) return undefined;
    const [clientDeviceId] = control.onlineDevicesFor(orgId, userId);
    if (!clientDeviceId) return undefined;
    return this.transportForUser({ orgId, userId, clientDeviceId, upstreamKeyId });
  }

  async stop(): Promise<void> {
    await this.#control?.close();
    await this.#relay?.close();
    this.#control = null;
    this.#relay = null;
    this.#registry = null;
    this.#relayUrl = '';
    this.#boundControlPort = 0;
    this.#boundRelayPort = 0;
  }
}
