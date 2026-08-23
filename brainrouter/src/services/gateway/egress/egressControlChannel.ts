import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { EdgeDialPush } from "./relayChannelOpener.js";

/** ADR-043 — the standing device→server control channel binds this path. */
export const EGRESS_CONTROL_PATH = "/egress-control";

/** Who a control-channel connection belongs to, after the hello is authenticated. */
export interface EdgeIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * Validate a device's hello frame and return its {@link EdgeIdentity}, or null to
 * reject. Injected so this channel owns transport + routing while the concrete
 * device-session verification lives with the control plane (C4 follow-up).
 */
export type EdgeHelloAuthenticator = (hello: Record<string, unknown>) => Promise<EdgeIdentity | null>;

export interface EgressControlChannelOptions {
  readonly authenticate: EdgeHelloAuthenticator;
  readonly path?: string;
  readonly now?: () => number;
  /** Close a connection that has not sent a valid hello within this window. */
  readonly helloDeadlineMs?: number;
  /** Max bytes of a single control frame; a hello is tiny, so cap it hard. */
  readonly maxHelloBytes?: number;
  /** Ceiling on concurrently-open sockets (authenticated + pending) — an
   * internet-facing listener must not let anonymous peers exhaust fds/heap. */
  readonly maxConnections?: number;
}

const DEFAULT_HELLO_DEADLINE_MS = 10_000;
/** A legitimate hello is a few hundred bytes; anything larger is abuse. */
const DEFAULT_MAX_HELLO_BYTES = 16 * 1024;
/** Generous vs. any realistic enrolled-device fleet; deployers may lower it. */
const DEFAULT_MAX_CONNECTIONS = 100_000;
const CLOSE_UNAUTHENTICATED = 4001;
const CLOSE_SUPERSEDED = 4002;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_OVERLOADED = 1013;

/**
 * Injective routing key. A plain `a:b:c` join is NOT injective — `{org:"a:b",…}`
 * and `{org:"a",user:"b:…"}` would collide onto one key, letting one tenant's
 * reconnect supersede another's control socket and misroute its dial ticket.
 * JSON-encoding the tuple escapes the delimiter so distinct identities stay
 * distinct.
 */
function deviceKey(id: EdgeIdentity): string {
  return JSON.stringify([id.orgId, id.userId, id.deviceId]);
}

/**
 * ADR-043 S3b (C4) — the standing control channel an enrolled edge holds open so
 * the gateway can PUSH a dial instruction to it (the per-dial ticket is 20 s TTL,
 * so it must be pushed, not polled). It carries ONLY control frames
 * (`hello`/`ready`/`dial`), never provider bytes — those flow over the separate
 * `/egress-relay` splice. The dial instruction names the client ticket + the
 * allowlisted target; the credential never appears here.
 *
 * One live connection per device: a new authenticated hello supersedes any prior
 * socket for the same (org,user,device), so a reconnect cannot leave a stale
 * push target. An unauthenticated socket is closed after `helloDeadlineMs`.
 */
export class EgressControlChannel {
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #authenticate: EdgeHelloAuthenticator;
  readonly #now: () => number;
  readonly #helloDeadlineMs: number;
  readonly #maxConnections: number;
  readonly #online = new Map<string, WebSocket>();
  #liveSockets = 0;
  #closed = false;

  constructor(options: EgressControlChannelOptions) {
    this.#authenticate = options.authenticate;
    this.#now = options.now ?? Date.now;
    this.#helloDeadlineMs = options.helloDeadlineMs ?? DEFAULT_HELLO_DEADLINE_MS;
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#http = createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
        res.writeHead(200, { "content-type": "application/json" });
        // Deliberately no online-device count — that would leak fleet size to an
        // unauthenticated GET on an internet-facing listener.
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.#wss = new WebSocketServer({
      server: this.#http,
      path: options.path ?? EGRESS_CONTROL_PATH,
      // A hello is a few hundred bytes; cap frames hard so an oversized payload
      // is rejected by `ws` (1009) instead of buffering toward the 100 MiB default.
      maxPayload: options.maxHelloBytes ?? DEFAULT_MAX_HELLO_BYTES,
    });
    this.#wss.on("connection", (socket) => this.#onConnection(socket));
  }

  #onConnection(socket: WebSocket): void {
    // Refuse new work once shutting down, and bound concurrent sockets so an
    // anonymous peer cannot exhaust fds/heap by opening connections in a loop.
    if (this.#closed) {
      try {
        socket.close(CLOSE_GOING_AWAY, "shutting down");
      } catch {
        /* best effort */
      }
      return;
    }
    if (this.#liveSockets >= this.#maxConnections) {
      try {
        socket.close(CLOSE_OVERLOADED, "too many connections");
      } catch {
        /* best effort */
      }
      return;
    }
    this.#liveSockets += 1;

    let authed: EdgeIdentity | null = null;
    // Synchronous one-shot latch. `authed` only flips inside the async `.then`,
    // but `ws` can emit several buffered frames back-to-back BEFORE that promise
    // settles, so a guard that reads `authed` would let a burst of hellos each
    // reach `authenticate()` (unauthenticated amplification) and double-register
    // the socket. This flag flips synchronously in the handler body, so at most
    // one hello is ever processed per socket.
    let helloHandled = false;
    const deadline = setTimeout(() => {
      if (!authed) socket.close(CLOSE_UNAUTHENTICATED, "no hello");
    }, this.#helloDeadlineMs);
    socket.on("close", () => {
      this.#liveSockets -= 1;
      clearTimeout(deadline);
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      // Control channel is text-JSON only; a binary frame is a protocol error.
      if (isBinary) {
        socket.close(CLOSE_UNAUTHENTICATED, "binary frame on control channel");
        return;
      }
      if (helloHandled) return; // exactly one hello per socket; nothing else is read
      helloHandled = true;
      let hello: Record<string, unknown>;
      try {
        hello = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      } catch {
        socket.close(CLOSE_UNAUTHENTICATED, "malformed hello");
        return;
      }
      void this.#authenticate(hello)
        .then((identity) => {
          if (!identity) {
            socket.close(CLOSE_UNAUTHENTICATED, "hello rejected");
            return;
          }
          // The channel may have shut down, or the socket may have closed, while
          // the authenticator ran — never resurrect a dead socket into #online.
          if (this.#closed || socket.readyState !== WebSocket.OPEN) {
            try {
              socket.close(CLOSE_GOING_AWAY, "unavailable");
            } catch {
              /* best effort */
            }
            return;
          }
          authed = identity;
          clearTimeout(deadline);
          const key = deviceKey(identity);
          // One live connection per device — supersede any prior socket.
          const prior = this.#online.get(key);
          if (prior && prior !== socket) {
            try {
              prior.close(CLOSE_SUPERSEDED, "superseded by a newer connection");
            } catch {
              /* best effort */
            }
          }
          this.#online.set(key, socket);
          socket.on("close", () => {
            if (this.#online.get(key) === socket) this.#online.delete(key);
          });
          socket.send(JSON.stringify({ kind: "ready" }));
        })
        .catch(() => {
          try {
            socket.close(CLOSE_UNAUTHENTICATED, "hello error");
          } catch {
            /* best effort */
          }
        });
    });
    socket.on("error", () => {
      /* handled by close */
    });
  }

  /** True if the named device currently holds a live control connection. */
  isOnline(id: EdgeIdentity): boolean {
    const socket = this.#online.get(deviceKey(id));
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  /**
   * The deviceIds of THIS (org,user)'s devices that currently hold a live control
   * connection. Scoped to one account (never a fleet enumeration) so the gateway
   * can resolve which of a requesting user's own devices can relay their traffic.
   */
  onlineDevicesFor(orgId: string, userId: string): string[] {
    const devices: string[] = [];
    for (const [key, socket] of this.#online) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      let tuple: unknown;
      try {
        tuple = JSON.parse(key);
      } catch {
        continue;
      }
      if (Array.isArray(tuple) && tuple[0] === orgId && tuple[1] === userId && typeof tuple[2] === 'string') {
        devices.push(tuple[2]);
      }
    }
    return devices;
  }

  /**
   * Push a dial instruction to a specific enrolled device. Returns whether it was
   * delivered (the device is online) — a false lets the opener fail fast so the
   * S4a fallback ladder drops to direct server egress.
   */
  pushDialToEdge(id: EdgeIdentity, push: EdgeDialPush): boolean {
    const socket = this.#online.get(deviceKey(id));
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(
      JSON.stringify({
        kind: "dial",
        clientToken: push.clientToken,
        sessionId: push.sessionId,
        relayUrl: push.relayUrl,
        expiresAt: push.expiresAt,
        host: push.target.host,
        port: push.target.port,
      }),
    );
    return true;
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(port, host, () => {
        const address = this.#http.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    // Flip first so any in-flight authenticate resolving after this point sees a
    // dead channel and refuses to re-register (no resurrection into #online).
    this.#closed = true;
    // Terminate EVERY live socket — authenticated (#online) AND pending (pre-hello,
    // never in #online). A lingering pending socket would otherwise keep the HTTP
    // server from closing, hanging shutdown.
    for (const socket of this.#wss.clients) {
      try {
        socket.terminate();
      } catch {
        /* best effort */
      }
    }
    this.#online.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    // Drop any lingering HTTP keep-alive sockets (e.g. a /health probe) so the
    // server stops instead of waiting on idle connections.
    (this.#http as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}
