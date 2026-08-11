/**
 * ADR-035 D10 — persistent-audio upgrade, admission, and shutdown controller.
 *
 * The HTTP server owns the only WebSocket upgrade listener used by the gateway.
 * This module validates route/origin/admission, owns the shared connection and
 * adapter-task inventories, and bounds shutdown. The per-connection protocol is
 * isolated in `audio-streaming-connection.ts` so controller cleanup cannot become
 * entangled with attach, chunk, transcript, or finish state.
 *
 * The shipped speech sidecar has no documented persistent protocol. Production
 * therefore injects no streaming port, advertises segmented upload only, and
 * rejects this upgrade without changing the batch POST route.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { MAX_INITIALIZATION_SEGMENT_BYTES } from "@kinqs/brainrouter-core/meetings";
import { WebSocket, WebSocketServer } from "ws";

import { isOriginAllowed, resolveCorsAllowlist } from "../../api/middleware/securityHeaders.js";
import type { GatewayAuthContext } from "./auth.js";
import { GatewayAudioAdmission } from "./audio-streaming-admission.js";
import { handleGatewayAudioConnection, type GatewayAudioConnectionLimits } from "./audio-streaming-connection.js";
import {
  GATEWAY_AUDIO_STREAM_PATH,
  type GatewayAudioStreamCloseReason,
  type GatewayAudioStreamSession,
  type GatewayAudioStreamingPort,
} from "./audio-streaming-protocol.js";

const DEFAULT_ATTACH_DEADLINE_MS = 10_000;
const DEFAULT_SEND_DEADLINE_MS = 30_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 1_000;
const DEFAULT_MAX_FRAME_BYTES = MAX_INITIALIZATION_SEGMENT_BYTES + 21;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FRAMES_PER_SECOND = 50;
const DEFAULT_MAX_CHUNK_DURATION_MS = 10_000;
const DEFAULT_MAX_PENDING_STREAMS = 64;
const DEFAULT_MAX_PENDING_STREAMS_PER_IP = 4;
const DEFAULT_MAX_STREAMS = 256;
const DEFAULT_MAX_STREAMS_PER_IP = 32;
const DEFAULT_MAX_STREAMS_PER_PRINCIPAL = 2;
const DEFAULT_MAX_STREAMS_PER_ORG = 20;
const DEFAULT_MAX_AGGREGATE_BYTES_PER_SECOND = 8 * 1024 * 1024;

export interface GatewayAudioStreamingOptions {
  readonly port?: GatewayAudioStreamingPort;
  readonly allowedOrigins?: readonly string[];
  readonly production?: boolean;
  readonly attachDeadlineMs?: number;
  readonly sendDeadlineMs?: number;
  readonly cleanupDeadlineMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxFramesPerSecond?: number;
  readonly maxChunkDurationMs?: number;
  readonly maxPendingStreams?: number;
  readonly maxPendingStreamsPerIp?: number;
  readonly maxStreams?: number;
  readonly maxStreamsPerIp?: number;
  readonly maxStreamsPerPrincipal?: number;
  readonly maxStreamsPerOrg?: number;
  readonly maxAggregateBytesPerSecond?: number;
  readonly now?: () => number;
}

export interface GatewayAudioStreamingAuthService {
  authenticate(bearer: string, requestedOrgId: string): Promise<GatewayAuthContext>;
}

export interface GatewayAudioStreamingController {
  /** Remove upgrade admission, close sockets, then await adapter cleanup within its configured bound. */
  close(): Promise<void>;
}

interface StreamingLimits extends GatewayAudioConnectionLimits {
  readonly cleanupDeadlineMs: number;
  readonly maxFrameBytes: number;
  readonly maxPendingStreams: number;
  readonly maxPendingStreamsPerIp: number;
  readonly maxStreams: number;
  readonly maxStreamsPerIp: number;
  readonly maxStreamsPerPrincipal: number;
  readonly maxStreamsPerOrg: number;
  readonly maxAggregateBytesPerSecond: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function limits(options: GatewayAudioStreamingOptions): StreamingLimits {
  const maxFrameBytes = boundedInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 1024, 1024 * 1024 + 21);
  return {
    attachDeadlineMs: boundedInteger(options.attachDeadlineMs, DEFAULT_ATTACH_DEADLINE_MS, 50, 60_000),
    sendDeadlineMs: boundedInteger(options.sendDeadlineMs, DEFAULT_SEND_DEADLINE_MS, 50, 120_000),
    cleanupDeadlineMs: boundedInteger(options.cleanupDeadlineMs, DEFAULT_CLEANUP_DEADLINE_MS, 50, 30_000),
    maxFrameBytes,
    maxQueuedBytes: boundedInteger(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, maxFrameBytes, 16 * 1024 * 1024),
    maxFramesPerSecond: boundedInteger(options.maxFramesPerSecond, DEFAULT_MAX_FRAMES_PER_SECOND, 1, 200),
    maxChunkDurationMs: boundedInteger(options.maxChunkDurationMs, DEFAULT_MAX_CHUNK_DURATION_MS, 1_000, 60_000),
    maxPendingStreams: boundedInteger(options.maxPendingStreams, DEFAULT_MAX_PENDING_STREAMS, 1, 10_000),
    maxPendingStreamsPerIp: boundedInteger(
      options.maxPendingStreamsPerIp,
      DEFAULT_MAX_PENDING_STREAMS_PER_IP,
      1,
      1_000,
    ),
    maxStreams: boundedInteger(options.maxStreams, DEFAULT_MAX_STREAMS, 1, 10_000),
    maxStreamsPerIp: boundedInteger(options.maxStreamsPerIp, DEFAULT_MAX_STREAMS_PER_IP, 1, 1_000),
    maxStreamsPerPrincipal: boundedInteger(options.maxStreamsPerPrincipal, DEFAULT_MAX_STREAMS_PER_PRINCIPAL, 1, 1_000),
    maxStreamsPerOrg: boundedInteger(options.maxStreamsPerOrg, DEFAULT_MAX_STREAMS_PER_ORG, 1, 10_000),
    maxAggregateBytesPerSecond: boundedInteger(
      options.maxAggregateBytesPerSecond,
      DEFAULT_MAX_AGGREGATE_BYTES_PER_SECOND,
      1,
      1024 * 1024 * 1024,
    ),
  };
}

const HTTP_STATUS_TEXT = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
} as const;

function rejectUpgrade(socket: Duplex, status: keyof typeof HTTP_STATUS_TEXT, message: string): void {
  const body = `${message}\n`;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${HTTP_STATUS_TEXT[status]}\r\n` +
        "content-type: text/plain; charset=utf-8\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "connection: close\r\n\r\n" +
        body,
    );
  } catch {
    socket.destroy();
  }
}

function requestPath(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://gateway.invalid");
  } catch {
    return null;
  }
}

function clientOriginAllowed(
  req: IncomingMessage,
  origin: string,
  allowlist: readonly string[],
  devPermissive: boolean,
): boolean {
  // Wildcard CORS is not sufficient for a credential-bearing WebSocket. Exact
  // origins preserve schemes, so http/https on one host are different grants.
  try {
    const parsed = new URL(origin);
    const scheme = "encrypted" in req.socket && req.socket.encrypted === true ? "https:" : "http:";
    if (origin === parsed.origin && req.headers.host && parsed.origin === `${scheme}//${req.headers.host}`) return true;
  } catch {
    return false;
  }
  return isOriginAllowed(
    origin,
    allowlist.filter((entry) => entry !== "*"),
    devPermissive,
  );
}

async function settleCleanupWithin(operation: Promise<void>, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One controller per HTTP server, shared by standalone and in-process mounts. */
export function attachGatewayAudioStreamingPlane(
  server: Server,
  service: GatewayAudioStreamingAuthService,
  options: GatewayAudioStreamingOptions = {},
): GatewayAudioStreamingController {
  const configuredLimits = limits(options);
  const port = options.port;
  const now = options.now ?? Date.now;
  const allowlist = [...(options.allowedOrigins ?? resolveCorsAllowlist())];
  const production = options.production ?? process.env.NODE_ENV === "production";
  const devPermissive = !production;
  const admission = new GatewayAudioAdmission(configuredLimits);
  const wss = new WebSocketServer({ noServer: true, maxPayload: configuredLimits.maxFrameBytes });
  const sockets = new Set<WebSocket>();
  const activeSessions = new Map<string, WebSocket>();
  const cleanups = new Map<WebSocket, (reason: GatewayAudioStreamCloseReason) => void>();
  const closedSessions = new WeakSet<object>();
  const operationTasks = new Set<Promise<void>>();
  const closeTasks = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const trackTask = (set: Set<Promise<void>>, task: Promise<void>): void => {
    set.add(task);
    void task.finally(() => set.delete(task));
  };

  const closePortSession = (
    session: GatewayAudioStreamSession,
    reason: GatewayAudioStreamCloseReason,
  ): Promise<void> => {
    if (closedSessions.has(session as object)) return Promise.resolve();
    closedSessions.add(session as object);
    const task = Promise.resolve()
      .then(() => session.close(reason))
      .catch(() => undefined);
    trackTask(closeTasks, task);
    return task;
  };

  const closeRawOpenResult = (value: unknown, reason: GatewayAudioStreamCloseReason): Promise<void> => {
    try {
      if (!value || typeof value !== "object") return Promise.resolve();
      const rawSession = (value as { session?: unknown }).session;
      if (!rawSession || typeof rawSession !== "object" || closedSessions.has(rawSession)) return Promise.resolve();
      const close = (rawSession as { close?: unknown }).close;
      if (typeof close !== "function") return Promise.resolve();
      closedSessions.add(rawSession);
      const task = Promise.resolve()
        .then(() => Reflect.apply(close, rawSession, [reason]))
        .catch(() => undefined);
      trackTask(closeTasks, task);
      return task;
    } catch {
      return Promise.resolve();
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = requestPath(req);
    if (!target) {
      rejectUpgrade(socket, 400, "WebSocket path is invalid.");
      return;
    }
    if (target.pathname !== GATEWAY_AUDIO_STREAM_PATH) {
      rejectUpgrade(socket, 404, "Unknown WebSocket route.");
      return;
    }
    if (target.search) {
      rejectUpgrade(socket, 400, "WebSocket query parameters are not accepted.");
      return;
    }
    const origin = req.headers.origin;
    if (origin && !clientOriginAllowed(req, origin, allowlist, devPermissive)) {
      rejectUpgrade(socket, 403, "WebSocket origin is not allowed.");
      return;
    }
    if (!port || closing) {
      rejectUpgrade(socket, 503, "Streaming transcription is unavailable.");
      return;
    }
    const lease = admission.tryAcquirePending(req.socket.remoteAddress ?? "unknown");
    if (!lease) {
      rejectUpgrade(socket, 429, "Streaming transcription admission is full.");
      return;
    }
    const releaseHandshakeLease = (): void => lease.release();
    socket.once("close", releaseHandshakeLease);
    socket.once("error", releaseHandshakeLease);
    try {
      wss.handleUpgrade(req, socket, head, (webSocket) => {
        socket.off("close", releaseHandshakeLease);
        socket.off("error", releaseHandshakeLease);
        handleGatewayAudioConnection(webSocket, lease, {
          service,
          port,
          limits: configuredLimits,
          now,
          activeSessions,
          register(ownedSocket, cleanup): void {
            sockets.add(ownedSocket);
            cleanups.set(ownedSocket, cleanup);
          },
          unregister(ownedSocket): void {
            sockets.delete(ownedSocket);
            cleanups.delete(ownedSocket);
          },
          closePortSession,
          closeRawOpenResult,
          trackOperation(task): void {
            trackTask(operationTasks, task);
          },
        });
      });
    } catch {
      socket.off("close", releaseHandshakeLease);
      socket.off("error", releaseHandshakeLease);
      lease.release();
      socket.destroy();
    }
  };
  server.on("upgrade", onUpgrade);

  return {
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      server.off("upgrade", onUpgrade);
      const cleanupWork = (async () => {
        const closingSockets = [...sockets];
        for (const cleanup of [...cleanups.values()]) cleanup("shutdown");
        for (const socket of closingSockets) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        while (operationTasks.size > 0 || closeTasks.size > 0) {
          await Promise.allSettled([...operationTasks, ...closeTasks]);
        }
        activeSessions.clear();
      })();
      // Adapter promises are an internal extension seam and may ignore abort.
      // Disposer chains remain attached to late results, but transport/process
      // shutdown never waits on those extension promises without a bound.
      closePromise = settleCleanupWithin(cleanupWork, configuredLimits.cleanupDeadlineMs);
      return closePromise;
    },
  };
}
