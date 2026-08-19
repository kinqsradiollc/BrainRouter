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
}

const DEFAULT_HELLO_DEADLINE_MS = 10_000;
const CLOSE_UNAUTHENTICATED = 4001;
const CLOSE_SUPERSEDED = 4002;

function deviceKey(id: EdgeIdentity): string {
  return `${id.orgId}:${id.userId}:${id.deviceId}`;
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
  readonly #online = new Map<string, WebSocket>();

  constructor(options: EgressControlChannelOptions) {
    this.#authenticate = options.authenticate;
    this.#now = options.now ?? Date.now;
    this.#helloDeadlineMs = options.helloDeadlineMs ?? DEFAULT_HELLO_DEADLINE_MS;
    this.#http = createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, online: this.#online.size }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.#wss = new WebSocketServer({ server: this.#http, path: options.path ?? EGRESS_CONTROL_PATH });
    this.#wss.on("connection", (socket) => this.#onConnection(socket));
  }

  #onConnection(socket: WebSocket): void {
    let authed: EdgeIdentity | null = null;
    const deadline = setTimeout(() => {
      if (!authed) socket.close(CLOSE_UNAUTHENTICATED, "no hello");
    }, this.#helloDeadlineMs);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      // Control channel is text-JSON only; a binary frame is a protocol error.
      if (isBinary) {
        socket.close(CLOSE_UNAUTHENTICATED, "binary frame on control channel");
        return;
      }
      if (authed) return; // post-hello the edge only receives; extra frames are ignored
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
          if (socket.readyState !== WebSocket.OPEN) return;
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
    for (const socket of this.#online.values()) {
      try {
        socket.close();
      } catch {
        /* best effort */
      }
    }
    this.#online.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}
