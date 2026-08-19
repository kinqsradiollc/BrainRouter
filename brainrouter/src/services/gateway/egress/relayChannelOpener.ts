import { WebSocket } from "ws";
import type { EgressChannel, EgressChannelOpener } from "./framedTransport.js";
import type { EgressDialTarget } from "./tunnelTransport.js";
import {
  EgressTicketRegistry,
  ORIGIN_DEVICE_PREFIX,
  type EgressSessionIdentity,
} from "./egressTicket.js";

/** Payload delivered out-of-band to the enrolled edge so it can attach its half. */
export interface EdgeDialPush {
  readonly clientToken: string;
  readonly sessionId: string;
  readonly relayUrl: string;
  readonly expiresAt: string;
  readonly target: EgressDialTarget;
}

export interface RelayEgressChannelOpenerDeps {
  readonly registry: EgressTicketRegistry;
  /** Resolve the requesting user's egress identity (org/user/clientDeviceId/upstreamKeyId) for a dial. */
  readonly identityFor: (target: EgressDialTarget) => EgressSessionIdentity;
  /** WS URL of the egress relay (C2), e.g. `ws://…/egress-relay`. */
  readonly egressRelayUrl: string;
  /** Deliver the CLIENT half of the pair to the edge out-of-band (C4). The ORIGIN token never leaves. */
  readonly pushDialToEdge: (push: EdgeDialPush) => Promise<void>;
  /** Injectable for tests; production opens a real `ws` WebSocket. */
  readonly wsFactory?: (url: string) => WebSocket;
  /** Bound the wait for the edge to attach; a slow/absent edge fails so the ladder falls back. */
  readonly peerConnectTimeoutMs?: number;
}

const DEFAULT_PEER_CONNECT_TIMEOUT_MS = 8_000;

/**
 * ADR-043 S3b (C3) — the relay-backed {@link EgressChannelOpener} the
 * {@link FramedEgressTransport} consumes. Per upstream dial it: mints a one-use
 * ticket pair (the ORIGIN token stays here, never crossing to the edge), pushes
 * the CLIENT half to the enrolled edge out-of-band, attaches the gateway/origin
 * seat to the egress relay, waits for the edge to attach (`peer-connected`), and
 * hands back an {@link EgressChannel} over the live splice.
 *
 * Security-critical demux: the relay delivers BOTH text control frames
 * (`attached` / `peer-connected` / `peer-disconnected`, handled here) and BINARY
 * peer frames (the edge's `dialed` ack + provider ciphertext). Only binary frames
 * are forwarded to `onMessage`; a text control frame is NEVER surfaced, or
 * `FramedEgressTransport` would mis-read it as the `dialed` ack and corrupt the
 * `dialing → open` transition. The credential and the dial target never reach the
 * relay — it splices opaque frames only.
 */
export function createRelayEgressChannelOpener(deps: RelayEgressChannelOpenerDeps): EgressChannelOpener {
  const wsFactory = deps.wsFactory ?? ((url: string) => new WebSocket(url));
  const peerTimeoutMs = deps.peerConnectTimeoutMs ?? DEFAULT_PEER_CONNECT_TIMEOUT_MS;

  return (target: EgressDialTarget, options?: { readonly signal?: AbortSignal }) =>
    new Promise<EgressChannel>((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(new Error("egress channel open aborted"));
        return;
      }

      const pair = deps.registry.issue(target, deps.identityFor(target));
      const ws = wsFactory(deps.egressRelayUrl);

      // `settled` guards the OPEN promise (resolve/reject once). After it flips
      // true the channel is live and messageHandler/closeHandler take over.
      let settled = false;
      let messageHandler: ((frame: Uint8Array) => void) | null = null;
      let closeHandler: ((reason?: string) => void) | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          /* best effort */
        }
        reject(err);
      };
      const onAbort = () => fail(new Error("egress channel open aborted"));
      const timer = setTimeout(() => fail(new Error("egress edge did not connect in time")), peerTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("error", (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));

      ws.on("open", () => {
        // Deliver the CLIENT half to the edge, THEN attach the origin seat. The
        // edge needs its ticket before it can join the splice.
        deps
          .pushDialToEdge({
            clientToken: pair.client.token,
            sessionId: pair.sessionId,
            relayUrl: deps.egressRelayUrl,
            expiresAt: pair.expiresAt,
            target,
          })
          .then(() => {
            ws.send(
              JSON.stringify({
                kind: "attach",
                ticket: pair.origin.token,
                deviceId: `${ORIGIN_DEVICE_PREFIX}${pair.sessionId}`,
              }),
            );
          })
          .catch((e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
      });

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // Application bytes from the edge. Before the channel is live there is
          // no handler yet (the edge should not send app bytes pre-splice); once
          // live, forward verbatim.
          messageHandler?.(new Uint8Array(data));
          return;
        }
        // Relay TEXT control frames — handled internally, never forwarded.
        let msg: { kind?: unknown };
        try {
          msg = JSON.parse(data.toString("utf8")) as { kind?: unknown };
        } catch {
          return;
        }
        // The splice is live as soon as BOTH seats are attached. The relay tells
        // whichever seat attaches SECOND via `attached{peerConnected:true}`, and
        // the seat that attached FIRST via a later `peer-connected`. The origin
        // may attach second (a warm edge that joined before us finishes the
        // out-of-band push), so we must accept either signal or the path stalls
        // until the timeout whenever the edge wins the attach race.
        const peerReady =
          msg.kind === "peer-connected" ||
          (msg.kind === "attached" && (msg as { peerConnected?: unknown }).peerConnected === true);
        if (peerReady && !settled) {
          settled = true;
          cleanup();
          resolve({
            send: (frame: Uint8Array) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
            },
            onMessage: (h) => {
              messageHandler = h;
            },
            onClose: (h) => {
              closeHandler = h;
            },
            close: (reason?: string) => {
              try {
                ws.close(1000, reason);
              } catch {
                /* best effort */
              }
            },
          });
        } else if (msg.kind === "peer-disconnected") {
          if (settled) closeHandler?.("peer-disconnected");
          else fail(new Error("egress edge disconnected before the splice was established"));
        }
        // `attached` is informational; the origin seat waits for `peer-connected`.
      });

      ws.on("close", () => {
        if (!settled) fail(new Error("egress relay closed before the edge connected"));
        else closeHandler?.();
      });
    });
}
