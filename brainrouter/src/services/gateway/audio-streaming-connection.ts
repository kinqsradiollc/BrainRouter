/**
 * ADR-035 D10 — one authenticated persistent-audio connection state machine.
 *
 * Upgrade routing, global admission ownership, and bounded controller shutdown
 * live in `audio-streaming-server.ts`. This module owns only the lifecycle after
 * a WebSocket has been accepted: first-frame authentication, immutable owner and
 * session metadata, container bootstrap, ordered durability chunks, contextual
 * transcript coverage, explicit finish, and idempotent per-session cleanup.
 */
import {
  isStreamingTranscriptionCapabilities,
  MAX_INITIALIZATION_SEGMENT_BYTES,
} from "@kinqs/brainrouter-core/meetings";
import { WebSocket, type RawData } from "ws";

import type { GatewayAuthContext } from "./auth.js";
import { gatewayAudioCapabilities } from "./audio-capabilities.js";
import type { GatewayAudioAdmissionLease } from "./audio-streaming-admission.js";
import { GatewayAudioEventChannel } from "./audio-streaming-events.js";
import {
  canonicalizeGatewayAudioOpenResult,
  GATEWAY_AUDIO_STREAM_CLOSE,
  GatewayAudioStreamConflictError,
  parseGatewayAudioAttach,
  parseGatewayAudioBinaryFrame,
  type GatewayAudioStreamCloseReason,
  type GatewayAudioStreamDropKind,
  type GatewayAudioStreamOpenResult,
  type GatewayAudioStreamOwner,
  type GatewayAudioStreamSession,
  type GatewayAudioStreamingPort,
} from "./audio-streaming-protocol.js";

export interface GatewayAudioConnectionLimits {
  readonly attachDeadlineMs: number;
  readonly sendDeadlineMs: number;
  readonly maxQueuedBytes: number;
  readonly maxFramesPerSecond: number;
  readonly maxChunkDurationMs: number;
}

export interface GatewayAudioConnectionAuthService {
  authenticate(bearer: string, requestedOrgId: string): Promise<GatewayAuthContext>;
}

export interface GatewayAudioConnectionEnvironment {
  readonly service: GatewayAudioConnectionAuthService;
  readonly port: GatewayAudioStreamingPort;
  readonly limits: GatewayAudioConnectionLimits;
  readonly now: () => number;
  readonly activeSessions: Map<string, WebSocket>;
  register(socket: WebSocket, cleanup: (reason: GatewayAudioStreamCloseReason) => void): void;
  unregister(socket: WebSocket): void;
  closePortSession(session: GatewayAudioStreamSession, reason: GatewayAudioStreamCloseReason): Promise<void>;
  closeRawOpenResult(value: unknown, reason: GatewayAudioStreamCloseReason): Promise<void>;
  trackOperation(task: Promise<void>): void;
}

interface ConnectionContext {
  readonly abort: AbortController;
  readonly admission: GatewayAudioAdmissionLease;
  portSession: GatewayAudioStreamSession | null;
  activeKey: string | null;
  cleanupStarted: boolean;
  cleanupReason: GatewayAudioStreamCloseReason;
  finishStarted: boolean;
  finishCompleted: boolean;
  initializationReceived: boolean;
  mimeType: string | null;
  queuedBytes: number;
  nextSequence: number;
  previousEndMs: number | null;
  sendTail: Promise<void>;
  frameTimestamps: number[];
}

function rawBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

function abortError(): Error {
  return new Error("Streaming transcription session closed.");
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function withDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Streaming transcription deadline exceeded.")), deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function frozenAuth(auth: GatewayAuthContext): GatewayAuthContext {
  return Object.freeze({ ...auth, scopes: Object.freeze([...auth.scopes]) }) as GatewayAuthContext;
}

function principalId(auth: GatewayAuthContext): string {
  return auth.principalType === "user" ? `user:${auth.userId}` : `service:${auth.servicePrincipalId}`;
}

function frozenOwner(auth: GatewayAuthContext, sessionId: string): GatewayAudioStreamOwner {
  return Object.freeze({ orgId: auth.orgId, principalId: principalId(auth), sessionId });
}

function ownerKey(owner: GatewayAudioStreamOwner): string {
  return `${owner.orgId}\u0000${owner.principalId}\u0000${owner.sessionId}`;
}

export function handleGatewayAudioConnection(
  socket: WebSocket,
  lease: GatewayAudioAdmissionLease,
  environment: GatewayAudioConnectionEnvironment,
): void {
  const { activeSessions, limits, now, port, service } = environment;
  const context: ConnectionContext = {
    abort: new AbortController(),
    admission: lease,
    portSession: null,
    activeKey: null,
    cleanupStarted: false,
    cleanupReason: "transport-drop",
    finishStarted: false,
    finishCompleted: false,
    initializationReceived: false,
    mimeType: null,
    queuedBytes: 0,
    nextSequence: 0,
    previousEndMs: null,
    sendTail: Promise.resolve(),
    frameTimestamps: [],
  };
  let attachTimer: NodeJS.Timeout | undefined;

  const cleanup = (reason: GatewayAudioStreamCloseReason): void => {
    if (context.cleanupStarted) return;
    context.cleanupStarted = true;
    context.cleanupReason = reason;
    if (attachTimer) clearTimeout(attachTimer);
    context.abort.abort();
    context.admission.release();
    environment.unregister(socket);
    if (context.activeKey && activeSessions.get(context.activeKey) === socket) {
      activeSessions.delete(context.activeKey);
    }
    if (context.portSession) void environment.closePortSession(context.portSession, reason);
  };
  environment.register(socket, cleanup);
  socket.once("close", () => cleanup(context.finishCompleted ? "finished" : "transport-drop"));
  socket.once("error", () => cleanup("transport-drop"));

  const sendSerialized = (payload: string): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > limits.maxQueuedBytes) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "stream backpressure limit exceeded");
      return false;
    }
    try {
      socket.send(payload);
      return true;
    } catch {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "stream output failed");
      return false;
    }
  };
  const sendJson = (payload: Record<string, unknown>): boolean => sendSerialized(JSON.stringify(payload));
  const events = new GatewayAudioEventChannel(
    (event) => {
      sendSerialized(JSON.stringify({ type: "transcript.event", event }));
    },
    (code, reason) => {
      closeSocket(socket, code, reason);
    },
  );

  let firstFrameSeen = false;
  attachTimer = setTimeout(() => {
    context.abort.abort();
    closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.attachTimeout, "attach deadline exceeded");
  }, limits.attachDeadlineMs);
  attachTimer.unref?.();

  const onBeforeAttach = (raw: RawData, isBinary: boolean): void => {
    if (firstFrameSeen) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "attach must complete before audio");
      return;
    }
    firstFrameSeen = true;
    if (isBinary) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "first frame must be attach JSON");
      return;
    }
    const attach = parseGatewayAudioAttach(Buffer.from(rawBytes(raw)).toString("utf8"));
    if (!attach) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "attach frame is invalid");
      return;
    }

    void (async () => {
      let auth: GatewayAuthContext;
      try {
        auth = await raceAbort(service.authenticate(attach.bearer, attach.requestedOrgId), context.abort.signal);
      } catch {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.authentication, "authentication failed");
        return;
      }
      const owner = frozenOwner(auth, attach.sessionId);
      if (!context.admission.promote(owner.principalId, owner.orgId)) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "stream concurrency limit exceeded");
        return;
      }
      const key = ownerKey(owner);
      if (activeSessions.has(key)) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.sessionConflict, "stream session is already attached");
        return;
      }
      activeSessions.set(key, socket);
      context.activeKey = key;

      const capabilities = await raceAbort(gatewayAudioCapabilities(port, auth), context.abort.signal).catch(
        () => null,
      );
      if (!capabilities || !isStreamingTranscriptionCapabilities(capabilities)) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.unavailable, "streaming transcription unavailable");
        return;
      }
      const latencyMode = capabilities.streaming.latencyModes.find((mode) => mode === attach.latencyMode);
      if (!latencyMode) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "latency mode is not supported");
        return;
      }

      const handlers = Object.freeze({
        onEvent: (event: unknown): void => {
          events.accept(event);
        },
        // Only the exact "input" classification changes the close code; every
        // other value, including none, stays the refundable outage answer.
        onDrop(kind?: GatewayAudioStreamDropKind): void {
          const undecodable = kind === "input";
          closeSocket(
            socket,
            undecodable ? GATEWAY_AUDIO_STREAM_CLOSE.undecodableAudio : GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure,
            undecodable ? "audio could not be decoded" : "transcription stream ended",
          );
        },
      });
      const openInput = Object.freeze({
        auth: frozenAuth(auth),
        owner,
        mimeType: attach.mimeType,
        language: attach.language,
        latencyMode,
        requestedResumeFromSequence: attach.resumeFromSequence,
        signal: context.abort.signal,
      });
      const openOperation = Promise.resolve()
        .then(() => port.open(openInput, handlers))
        .then((raw) => ({ raw, canonical: canonicalizeGatewayAudioOpenResult(raw, owner) }));
      const lateCleanup = openOperation
        .then(({ raw, canonical }) => {
          if (context.abort.signal.aborted || socket.readyState !== WebSocket.OPEN) {
            return canonical
              ? environment.closePortSession(canonical.session, context.cleanupReason)
              : environment.closeRawOpenResult(raw, context.cleanupReason);
          }
          return undefined;
        })
        .catch(() => undefined);
      environment.trackOperation(lateCleanup);

      let opened: GatewayAudioStreamOpenResult;
      try {
        const resolved = await raceAbort(openOperation, context.abort.signal);
        if (!resolved.canonical) {
          void environment.closeRawOpenResult(resolved.raw, "transport-drop");
          throw new Error("Streaming adapter returned an invalid accepted state.");
        }
        opened = resolved.canonical;
        const acceptedCheckpoint = opened.accepted.acceptedResumeFromSequence;
        if (
          (attach.resumeFromSequence === null && acceptedCheckpoint !== null) ||
          (attach.resumeFromSequence !== null &&
            acceptedCheckpoint !== null &&
            acceptedCheckpoint > attach.resumeFromSequence)
        ) {
          void environment.closePortSession(opened.session, "transport-drop");
          throw new Error("Streaming adapter accepted an untrusted resume checkpoint.");
        }
        context.portSession = opened.session;
      } catch (error) {
        closeSocket(
          socket,
          error instanceof GatewayAudioStreamConflictError
            ? GATEWAY_AUDIO_STREAM_CLOSE.sessionConflict
            : GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure,
          error instanceof GatewayAudioStreamConflictError
            ? "stream session cannot be resumed"
            : "transcription stream unavailable",
        );
        return;
      }
      if (context.abort.signal.aborted || socket.readyState !== WebSocket.OPEN) {
        void environment.closePortSession(opened.session, context.cleanupReason);
        return;
      }

      context.nextSequence = (opened.accepted.acceptedResumeFromSequence ?? -1) + 1;
      context.mimeType = attach.mimeType;
      events.acceptResume(opened.accepted.acceptedResumeFromSequence);

      clearTimeout(attachTimer);
      events.markAttached();
      socket.off("message", onBeforeAttach);
      socket.on("message", onStreamMessage);
      if (
        !sendJson({
          type: "attached",
          sessionId: owner.sessionId,
          generation: opened.accepted.generation,
          acceptedResumeFromSequence: opened.accepted.acceptedResumeFromSequence,
          latencyMode,
        })
      )
        return;
      // Adapter events emitted during open are canonical and contextualized,
      // but attached remains the first wire message.
      events.flush();
    })().catch(() => {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "transcription stream unavailable");
    });
  };

  const handleFinish = (): void => {
    if (context.finishStarted || !context.initializationReceived || !context.portSession) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "finish frame is not valid now");
      return;
    }
    context.finishStarted = true;
    const finishTask = context.sendTail
      .then(async () => {
        if (context.abort.signal.aborted || !context.portSession) return;
        await withDeadline(Promise.resolve(context.portSession.finish()), limits.sendDeadlineMs);
        context.finishCompleted = true;
        if (sendJson({ type: "finished" })) closeSocket(socket, 1000, "stream finished");
      })
      .catch(() => {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "transcription finish failed");
      });
    environment.trackOperation(finishTask);
  };

  const onStreamMessage = (raw: RawData, isBinary: boolean): void => {
    if (!isBinary) {
      let control: unknown;
      try {
        control = JSON.parse(Buffer.from(rawBytes(raw)).toString("utf8"));
      } catch {
        control = null;
      }
      if (
        control &&
        typeof control === "object" &&
        !Array.isArray(control) &&
        Object.keys(control).length === 1 &&
        (control as { type?: unknown }).type === "finish"
      ) {
        handleFinish();
        return;
      }
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "stream control frame is invalid");
      return;
    }
    if (context.finishStarted) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "audio cannot follow finish");
      return;
    }
    const at = now();
    context.frameTimestamps.push(at);
    while (context.frameTimestamps[0] !== undefined && context.frameTimestamps[0] < at - 1_000) {
      context.frameTimestamps.shift();
    }
    if (context.frameTimestamps.length > limits.maxFramesPerSecond) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "audio frame rate exceeded");
      return;
    }
    const parsed = parseGatewayAudioBinaryFrame(rawBytes(raw));
    if (!parsed) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "audio frame is invalid");
      return;
    }
    if (parsed.kind === "initialization") {
      if (context.initializationReceived) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "container initialization was already received");
        return;
      }
      if (parsed.initialization.byteLength > MAX_INITIALIZATION_SEGMENT_BYTES) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.tooLarge, "container initialization is too large");
        return;
      }
      if (
        parsed.initialization.byteLength > 0 &&
        !context.admission.consumeBytes(parsed.initialization.byteLength, at)
      ) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "aggregate audio rate exceeded");
        return;
      }
      const initialization = Uint8Array.from(parsed.initialization);
      if (context.queuedBytes + initialization.byteLength > limits.maxQueuedBytes) {
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "audio queue limit exceeded");
        return;
      }
      context.initializationReceived = true;
      context.queuedBytes += initialization.byteLength;
      const initializationInput = Object.freeze({
        mimeType: context.mimeType!,
        initializationSegment: initialization,
      });
      context.sendTail = context.sendTail
        .then(async () => {
          if (context.abort.signal.aborted || !context.portSession) return;
          const pendingStart = events.beginDelivery();
          try {
            await withDeadline(
              Promise.resolve(context.portSession.initialize(initializationInput)),
              limits.sendDeadlineMs,
            );
          } catch (error) {
            events.deliveryFailed(pendingStart);
            throw error;
          }
          events.deliverySucceeded(null);
        })
        .catch(() => {
          context.abort.abort();
          closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "transcription stream unavailable");
        })
        .finally(() => {
          context.queuedBytes -= initialization.byteLength;
        });
      return;
    }
    if (!context.initializationReceived) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.protocol, "container initialization must precede audio");
      return;
    }
    if (parsed.sequence !== context.nextSequence) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "audio sequence is not contiguous");
      return;
    }
    if (
      parsed.endMs - parsed.startMs > limits.maxChunkDurationMs ||
      (context.previousEndMs !== null && parsed.startMs < context.previousEndMs)
    ) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.invalidRequest, "audio range is not monotonic");
      return;
    }
    if (!context.admission.consumeBytes(parsed.audio.byteLength, at)) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "aggregate audio rate exceeded");
      return;
    }
    if (context.queuedBytes + parsed.audio.byteLength > limits.maxQueuedBytes) {
      closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.overloaded, "audio queue limit exceeded");
      return;
    }
    const sequence = parsed.sequence;
    const audio = Uint8Array.from(parsed.audio);
    const chunk = Object.freeze({
      sequence,
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      audio,
    });
    context.nextSequence += 1;
    context.previousEndMs = parsed.endMs;
    context.queuedBytes += audio.byteLength;
    context.sendTail = context.sendTail
      .then(async () => {
        if (context.abort.signal.aborted || !context.portSession) return;
        const pendingStart = events.beginDelivery();
        try {
          await withDeadline(Promise.resolve(context.portSession.send(chunk)), limits.sendDeadlineMs);
        } catch (error) {
          events.deliveryFailed(pendingStart);
          throw error;
        }
        events.deliverySucceeded(sequence);
      })
      .catch(() => {
        context.abort.abort();
        closeSocket(socket, GATEWAY_AUDIO_STREAM_CLOSE.upstreamFailure, "transcription stream unavailable");
      })
      .finally(() => {
        context.queuedBytes -= audio.byteLength;
      });
  };

  socket.on("message", onBeforeAttach);
}
