/**
 * Remote-relay WSS edge (spec §9, Task 22). Both devices connect OUTBOUND and
 * authenticate with a single-use relay ticket presented in the FIRST frame —
 * never in the URL/query — then the relay splices opaque frames between the two
 * enrolled devices of one approved grant.
 *
 * Trust boundary: the relay validates tickets and routes ciphertext. It cannot
 * decrypt payloads (E2EE keys never reach it) and never persists frame content;
 * only bounded metadata (counts, sizes) is observable. Bounded frames, queues,
 * and rates fail the connection closed rather than buffering unbounded data.
 *
 * Multi-instance boundary: pairing state is in-process, so both devices of a
 * grant must land on the same instance (sticky routing by grant). Revocation is
 * push-based via {@link RemoteRelayServer.revoke} and can be fanned out across
 * instances by an injected {@link RelayRevocationFeed}; a shared registry is a
 * documented follow-up, not silently assumed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { RemoteRelayTicketRecord } from "../../remote/store.js";
import type { RemoteControlPlaneService } from "./tickets.js";

export const RELAY_PATH = "/remote-relay";
export const MAX_FRAME_BYTES = 128 * 1024;
const ATTACH_DEADLINE_MS = 10_000;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const FRAMES_PER_SECOND = 200;

/** Close codes surfaced to clients. Payload-free by design. */
export const RELAY_CLOSE = {
  invalidTicket: 4401,
  revoked: 4403,
  attachTimeout: 4408,
  peerReplaced: 4409,
  protocol: 1002,
  tooLarge: 1009,
  rateLimited: 1008,
  overloaded: 1013,
} as const;

export interface RelayRevocationSelector {
  grantId?: string;
  deviceId?: string;
  sessionFamilyId?: string;
}

/** Optional cross-instance revocation fan-in (e.g. LISTEN/NOTIFY adapter). */
export interface RelayRevocationFeed {
  subscribe(listener: (selector: RelayRevocationSelector) => void): () => void;
}

export interface RemoteRelayServerOptions {
  controlPlane: Pick<RemoteControlPlaneService, "consumeRelayTicket">;
  /** Readiness probe — normally the store's DB ping. */
  ping(): Promise<boolean>;
  revocationFeed?: RelayRevocationFeed;
  now?: () => number;
  attachDeadlineMs?: number;
  framesPerSecond?: number;
  /**
   * The WebSocket path this instance binds. Defaults to {@link RELAY_PATH}
   * (`/remote-relay`, device pairing). ADR-043's egress relay binds a distinct
   * path (`/egress-relay`) with an egress control plane, so the two audiences
   * never share an endpoint even when co-located.
   */
  path?: string;
}

interface AttachedConnection {
  socket: WebSocket;
  ticket: RemoteRelayTicketRecord;
  /** Frames forwarded to this connection while its peer sender is being read. */
  queuedBytes: number;
  frameTimestamps: number[];
}

interface GrantPair {
  byDevice: Map<string, AttachedConnection>;
}

function send(socket: WebSocket, value: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export class RemoteRelayServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly pairs = new Map<string, GrantPair>();
  private readonly now: () => number;
  private readonly attachDeadlineMs: number;
  private readonly framesPerSecond: number;
  private unsubscribeRevocations: (() => void) | null = null;

  constructor(private readonly options: RemoteRelayServerOptions) {
    this.now = options.now ?? Date.now;
    this.attachDeadlineMs = options.attachDeadlineMs ?? ATTACH_DEADLINE_MS;
    this.framesPerSecond = options.framesPerSecond ?? FRAMES_PER_SECOND;
    this.http = createServer((req, res) => { void this.handleHttp(req, res); });
    this.wss = new WebSocketServer({ server: this.http, path: options.path ?? RELAY_PATH, maxPayload: MAX_FRAME_BYTES });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    if (options.revocationFeed) {
      this.unsubscribeRevocations = options.revocationFeed.subscribe((selector) => this.revoke(selector));
    }
  }

  /** Liveness/readiness — no auth, no tenant data. */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
      let db = false;
      try { db = await this.options.ping(); } catch { db = false; }
      res.statusCode = db ? 200 : 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: db ? "ok" : "degraded", service: "remote-relay", db, connections: this.connectionCount() }));
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private connectionCount(): number {
    let n = 0;
    for (const pair of this.pairs.values()) n += pair.byDevice.size;
    return n;
  }

  private handleConnection(socket: WebSocket): void {
    // The first frame must be the attach envelope; anything else — or silence
    // past the deadline — fails closed. Tickets never appear in the URL.
    const deadline = setTimeout(() => socket.close(RELAY_CLOSE.attachTimeout, "attach timeout"), this.attachDeadlineMs);
    socket.once("message", (raw: RawData) => {
      clearTimeout(deadline);
      void this.attach(socket, raw);
    });
  }

  private async attach(socket: WebSocket, raw: RawData): Promise<void> {
    let frame: { kind?: unknown; ticket?: unknown; deviceId?: unknown };
    try {
      frame = JSON.parse(raw.toString("utf8"));
    } catch {
      socket.close(RELAY_CLOSE.protocol, "attach frame must be JSON");
      return;
    }
    if (frame.kind !== "attach" || typeof frame.ticket !== "string" || typeof frame.deviceId !== "string") {
      socket.close(RELAY_CLOSE.protocol, "attach frame is invalid");
      return;
    }
    let ticket: RemoteRelayTicketRecord | null = null;
    try {
      ticket = await this.options.controlPlane.consumeRelayTicket(frame.ticket, frame.deviceId);
    } catch {
      ticket = null;
    }
    if (!ticket) {
      socket.close(RELAY_CLOSE.invalidTicket, "relay ticket is invalid, expired, revoked, or replayed");
      return;
    }

    const pair = this.pairs.get(ticket.grantId) ?? { byDevice: new Map() };
    this.pairs.set(ticket.grantId, pair);
    // A reconnect replaces the previous socket for the same device (new epoch);
    // the old connection is closed so stale counters cannot continue.
    const previous = pair.byDevice.get(ticket.presentingDeviceId);
    if (previous) previous.socket.close(RELAY_CLOSE.peerReplaced, "replaced by a newer connection");
    const connection: AttachedConnection = { socket, ticket, queuedBytes: 0, frameTimestamps: [] };
    pair.byDevice.set(ticket.presentingDeviceId, connection);

    const peer = pair.byDevice.get(ticket.peerDeviceId) ?? null;
    send(socket, {
      kind: "attached",
      relaySessionId: ticket.id,
      scopes: ticket.scopes,
      peerConnected: Boolean(peer),
    });
    if (peer) send(peer.socket, { kind: "peer-connected" });

    socket.on("message", (data: RawData, isBinary: boolean) => this.forward(connection, data, isBinary));
    socket.on("close", () => this.detach(connection));
    socket.on("error", () => socket.close(RELAY_CLOSE.protocol, "socket error"));
  }

  /** Opaque splice: bound rate + backpressure, never parse or persist payloads. */
  private forward(from: AttachedConnection, data: RawData, isBinary: boolean): void {
    const at = this.now();
    from.frameTimestamps.push(at);
    while (from.frameTimestamps.length > 0 && from.frameTimestamps[0] < at - 1_000) from.frameTimestamps.shift();
    if (from.frameTimestamps.length > this.framesPerSecond) {
      from.socket.close(RELAY_CLOSE.rateLimited, "frame rate exceeded");
      return;
    }
    const pair = this.pairs.get(from.ticket.grantId);
    const peer = pair?.byDevice.get(from.ticket.peerDeviceId);
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) {
      send(from.socket, { kind: "peer-disconnected" });
      return;
    }
    if (peer.socket.bufferedAmount > MAX_QUEUED_BYTES) {
      peer.socket.close(RELAY_CLOSE.overloaded, "peer backpressure limit exceeded");
      return;
    }
    peer.socket.send(data, { binary: isBinary });
  }

  private detach(connection: AttachedConnection): void {
    const pair = this.pairs.get(connection.ticket.grantId);
    if (!pair) return;
    if (pair.byDevice.get(connection.ticket.presentingDeviceId) === connection) {
      pair.byDevice.delete(connection.ticket.presentingDeviceId);
      const peer = pair.byDevice.get(connection.ticket.peerDeviceId);
      if (peer) send(peer.socket, { kind: "peer-disconnected" });
    }
    if (pair.byDevice.size === 0) this.pairs.delete(connection.ticket.grantId);
  }

  /** Disconnect every connection matching the selector (grant/device/session revocation). */
  revoke(selector: RelayRevocationSelector): number {
    let closed = 0;
    for (const pair of this.pairs.values()) {
      for (const connection of [...pair.byDevice.values()]) {
        const t = connection.ticket;
        const matches = (selector.grantId && t.grantId === selector.grantId)
          || (selector.deviceId && (t.presentingDeviceId === selector.deviceId || t.peerDeviceId === selector.deviceId))
          || (selector.sessionFamilyId && t.sessionFamilyId === selector.sessionFamilyId);
        if (matches) {
          connection.socket.close(RELAY_CLOSE.revoked, "remote access was revoked");
          closed += 1;
        }
      }
    }
    return closed;
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => {
        const address = this.http.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    this.unsubscribeRevocations?.();
    for (const pair of this.pairs.values()) {
      for (const connection of pair.byDevice.values()) connection.socket.close(1001, "relay shutting down");
    }
    this.pairs.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.http.close((err) => (err ? reject(err) : resolve())));
  }
}
