/**
 * ADR-043 S3b (C5a) — the desktop half of the egress control channel. The device
 * holds ONE standing outbound WSS to the server's `/egress-control` endpoint so
 * the server can PUSH it a per-dial ticket (20 s TTL → push, not poll). This
 * client authenticates the standing connection with the SAME enrolled-device
 * credential the relay client uses (deviceId + rotating device-session refresh
 * token, sealed in OS storage), presented in a `hello` first frame.
 *
 * Credential rules mirror the relay client: the refresh token only ever proves
 * the device on THIS control channel — it is compared as a hash server-side and
 * never travels anywhere else on the wire. The channel carries ONLY control
 * frames (`hello` → `ready`, then `dial` pushes); no provider bytes and no
 * credential ever cross it — those flow over the separate `/egress-relay` splice
 * that the C5b dial handler opens per dial.
 *
 * This module ships dark: it delivers each parsed `dial` push to an injected
 * `onDial` callback and does nothing else. The actual dial-the-provider-and-
 * splice behaviour (and its allowlist / SSRF enforcement) lives in C5b.
 */
import type { RemoteSecretsPort, BrokerSocketLike } from './remoteAccessClient.js';

/**
 * Secret keys shared with {@link RemoteAccessClient} (kept in sync with its
 * private `KEYS`). The control channel reuses the same enrolled-device identity;
 * it reads the refresh token FRESH on every connect so a rotation is picked up.
 */
const DEVICE_ID_KEY = 'remote.deviceId';
const REFRESH_TOKEN_KEY = 'remote.refreshToken';

const MAX_RECONNECT_DELAY_MS = 60_000;

/** The dial instruction the server pushes over the standing channel. Mirrors the
 * gateway's `dial` frame (egressControlChannel.pushDialToEdge). */
export interface EgressDialInstruction {
  readonly clientToken: string;
  readonly sessionId: string;
  readonly relayUrl: string;
  readonly expiresAt: string;
  readonly host: string;
  readonly port: number;
}

export interface EgressControlClientDeps {
  /** Relay/broker base, e.g. wss://relay.brainrouter.ai — null when the tunnel is off. */
  relayUrl(): string | null;
  /** The active account's org/user for the hello — null when signed out / no active org. */
  identity(): { orgId: string; userId: string } | null;
  /** OS-protected storage holding the enrolled deviceId + rotating refresh token. */
  secrets: RemoteSecretsPort;
  wsFactory(url: string): BrokerSocketLike;
  /** Invoked for each valid `dial` push. Ships dark: default handler is a no-op. */
  onDial(instruction: EgressDialInstruction): void;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class EgressControlClient {
  private stopped = true;
  private ready = false;
  private reconnectDelayMs = 1_000;
  private activeSocket: BrokerSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: EgressControlClientDeps) {}

  /** Begin holding the standing channel open (idempotent). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectDelayMs = 1_000;
    this.connect();
  }

  /** Tear the channel down and cancel any pending reconnect. */
  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.activeSocket?.close(1000, 'egress control stopped');
    this.activeSocket = null;
  }

  /** True once the server has acknowledged the hello with `ready`. */
  isReady(): boolean {
    return this.ready && this.activeSocket !== null;
  }

  private connect(): void {
    if (this.stopped) return;
    const relayBase = this.deps.relayUrl();
    const identity = this.deps.identity();
    const deviceId = this.deps.secrets.get(DEVICE_ID_KEY);
    const deviceToken = this.deps.secrets.get(REFRESH_TOKEN_KEY);
    // Not ready yet (tunnel off / signed out / not enrolled) — retry later rather
    // than open a socket we cannot authenticate.
    if (!relayBase || !identity || !deviceId || !deviceToken) {
      this.scheduleReconnect();
      return;
    }

    const socket = this.deps.wsFactory(`${relayBase.replace(/\/+$/, '')}/egress-control`);
    this.activeSocket = socket;
    this.ready = false;

    socket.once('open', () => {
      // The hello carries org/user/device + the CURRENT rotating refresh token.
      // The server binds them to the device session and rejects a mismatch, so a
      // client cannot claim another identity by lying in these fields.
      socket.send(
        JSON.stringify({ kind: 'hello', orgId: identity.orgId, userId: identity.userId, deviceId, deviceToken }),
      );
    });
    socket.on('message', (...args: unknown[]) => this.onMessage(args[0]));
    socket.once('close', () => {
      this.activeSocket = null;
      this.ready = false;
      // Any close reconnects with backoff. A 4001 (auth-reject) also backs off —
      // a rotated/expired token will have been refreshed in secrets by the time
      // the next attempt reads it fresh, and the cap keeps a persistent reject
      // from hammering the server.
      this.scheduleReconnect();
    });
    socket.once('error', () => {
      /* the close handler owns the retry */
    });
  }

  private onMessage(data: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.kind === 'ready') {
      this.ready = true;
      this.reconnectDelayMs = 1_000; // healthy connection — reset backoff
      return;
    }
    if (msg.kind === 'dial') {
      const instruction = this.parseDial(msg);
      if (instruction) this.deps.onDial(instruction);
    }
  }

  /** Validate the SHAPE of a dial frame. Security (allowlist / private-IP refusal)
   * is enforced by the C5b handler right before it dials. */
  private parseDial(msg: Record<string, unknown>): EgressDialInstruction | null {
    const clientToken = nonEmptyString(msg.clientToken);
    const sessionId = nonEmptyString(msg.sessionId);
    const relayUrl = nonEmptyString(msg.relayUrl);
    const expiresAt = nonEmptyString(msg.expiresAt);
    const host = nonEmptyString(msg.host);
    const port = typeof msg.port === 'number' ? msg.port : NaN;
    if (!clientToken || !sessionId || !relayUrl || !expiresAt || !host) return null;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return { clientToken, sessionId, relayUrl, expiresAt, host, port };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}
