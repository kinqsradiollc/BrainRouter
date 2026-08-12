/**
 * ADR-035 D10 — the real streaming adapter: BrainRouter's normalized port,
 * implemented against the first-party speech sidecar's live endpoint.
 *
 * This is the thing the ADR listed as Pending. Everything around it already
 * existed and was dormant: the capability contract, the authenticated upgrade,
 * admission, bounded lifetimes, bounded shutdown. What was missing was a `port`
 * to inject, and this is it — off unless `BRAINROUTER_STT_STREAM_URL` names an
 * endpoint (`audio-streaming-endpoint.ts` owns that gate).
 *
 * ## What this module keeps, that the sidecar does not
 *
 * The sidecar speaks in audio time: partial/final utterances and a committed
 * millisecond, all measured from the first sample IT received. The D10 contract
 * speaks in the host's durability ledger: utterances on the meeting's timeline
 * and coverage over D9 chunk SEQUENCES. Translating between those is this
 * module's whole job, and it is why coverage cannot be the sidecar's to state:
 *
 * - **Timeline.** The first chunk sent on this connection fixes the offset, so a
 *   resumed stream that starts at chunk 412 reports utterances at their real
 *   elapsed time rather than at zero.
 * - **Coverage.** A committed millisecond becomes the highest sequence this
 *   adapter has already finished SENDING whose chunk ends at or before it. It
 *   can never name a chunk the endpoint has not heard, and it only moves
 *   forward — the two properties `audio-streaming-events.ts` enforces and would
 *   otherwise close the stream over.
 * - **Revisions.** The gateway's reducer requires a revision that does not go
 *   backwards for an utterance id, so the number is minted here rather than
 *   trusted from the wire, and ids are namespaced by this connection's
 *   generation so a reconnect cannot collide with an utterance the host already
 *   sealed.
 *
 * ## Resumability is honest, not simulated
 *
 * A new connection means a new decode, so the checkpoint this adapter accepts is
 * exactly the one the host proved it persisted — never a higher one. The host
 * replays from the next chunk out of audio that is already on disk, which is
 * what makes a dropped connection cost a reconnect instead of a meeting.
 *
 * ## Nothing the endpoint says reaches a client
 *
 * `audioRoutes.ts` made that decision for the batch route and this one matches
 * it: sidecar prose goes to our logs, and the only thing that crosses the port
 * is one of two fixed classifications — `input` (these bytes will never decode,
 * close 4422, degrade to segmented) or `dependency` (the endpoint failed, close
 * 1011, the same bytes are worth retrying). Without that split D7 breaks the
 * moment streaming is on, because every outage would read as bad audio.
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { createPinnedLookup, validateUpstreamTarget } from "@kinqs/brainrouter-core/provider";

import type { GatewayAuthContext } from "./auth.js";
import {
  createGatewayAudioCapabilityCache,
  resolveGatewayAudioStreamingEndpoint,
  type GatewayAudioStreamingEndpoint,
} from "./audio-streaming-endpoint.js";
import type {
  GatewayAudioChunkFrame,
  GatewayAudioStreamDropKind,
  GatewayAudioStreamHandlers,
  GatewayAudioStreamInitialization,
  GatewayAudioStreamOpenInput,
  GatewayAudioStreamOpenResult,
  GatewayAudioStreamingPort,
} from "./audio-streaming-protocol.js";

/** One event line. The endpoint caps utterance text well below this; a longer line is not one of ours. */
const MAX_EVENT_LINE_CHARS = 64 * 1024;
/** The gateway's own transcript ceiling, applied here so an oversized text is trimmed rather than fatal. */
const MAX_TRANSCRIPT_CHARS = 64_000;
/** Chunks awaiting a coverage answer. ~3 s each, so this is hours of un-acknowledged audio. */
const MAX_TRACKED_CHUNKS = 4_096;
/** Utterances can only be in flight a few at a time; this is slack, not a budget. */
const MAX_TRACKED_UTTERANCES = 64;
/** Comfortably under the connection's default 30 s send deadline, whatever the endpoint timeout is set to. */
const MAX_FINISH_WAIT_MS = 20_000;
const UTTERANCE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface TrackedChunk {
  readonly sequence: number;
  readonly endMs: number;
}

/** An elapsed millisecond on a meeting's timeline: a whole number of ms, and not a year of them. */
function isElapsed(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/**
 * Open the request with DNS pinned to the addresses just validated.
 *
 * `fetchUpstreamWithPolicy` is the right transport for a request that has a
 * body and then a response; this one writes audio for an hour WHILE reading
 * events, so it uses `node:http` directly and takes the same pinned-lookup
 * protection through the same core validator.
 */
async function openUpstream(
  endpoint: GatewayAudioStreamingEndpoint,
  input: GatewayAudioStreamOpenInput,
): Promise<ClientRequest> {
  const target = await validateUpstreamTarget(`${endpoint.origin}${endpoint.streamPath}`, endpoint.policy);
  const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = send({
    protocol: target.url.protocol,
    hostname: target.hostname,
    port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
    path: `${target.url.pathname}${target.url.search}`,
    method: "POST",
    headers: {
      "content-type": input.mimeType,
      "x-latency-mode": input.latencyMode,
      ...(input.language ? { "x-language": input.language } : {}),
    },
    lookup: createPinnedLookup(target) as never,
  });
  // A chunked request holds its head until the first byte of body, and the first
  // byte is a chunk of audio that has not been recorded yet — so the endpoint
  // would never see the session and could never answer. Flushing is what makes
  // this full duplex rather than request-then-response.
  request.flushHeaders();
  // The transport is torn down deliberately at several points; a socket error is
  // always handled by whoever is watching, and must never escape as an unhandled
  // 'error' event on the way there.
  request.on("error", () => undefined);
  return request;
}

function awaitResponse(request: ClientRequest, timeoutMs: number, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const fail = (error: Error): void => {
      cleanup();
      request.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Streaming transcription endpoint did not answer in time.")), timeoutMs);
    const onAbort = (): void => fail(new Error("Streaming transcription session closed."));
    const onError = (): void => fail(new Error("The streaming transcription endpoint could not be reached."));
    const onResponse = (response: IncomingMessage): void => {
      cleanup();
      resolve(response);
    };
    // Every listener is removed on settle: the session installs its own, and a
    // handshake watcher left behind would tear a live stream down on its first
    // recoverable socket event.
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      request.off("error", onError);
      request.off("response", onResponse);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("error", onError);
    request.once("response", onResponse);
  });
}

/**
 * One live session. Every method fences on `closed`, so a late send, a late
 * event, or a late finish after the controller has torn the connection down is
 * a no-op rather than a write into somebody else's meeting.
 */
function createSession(
  endpoint: GatewayAudioStreamingEndpoint,
  input: GatewayAudioStreamOpenInput,
  handlers: GatewayAudioStreamHandlers,
  request: ClientRequest,
  response: IncomingMessage,
  generation: string,
): GatewayAudioStreamOpenResult {
  let closed = false;
  let finishing = false;
  let baseMs: number | null = null;
  let lastSentSequence: number | null = null;
  let coveredThroughSequence = input.requestedResumeFromSequence ?? -1;
  let pending = "";
  let tracked: TrackedChunk[] = [];
  let trackedFloor: TrackedChunk | null = null;
  const revisions = new Map<string, number>();
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const teardown = (): void => {
    closed = true;
    resolveEnded();
    request.destroy();
    response.destroy();
  };

  const drop = (kind: GatewayAudioStreamDropKind): void => {
    if (closed) return;
    teardown();
    handlers.onDrop(kind);
  };

  /** The highest sequence already sent whose chunk ends at or before `atMs`. */
  const coverageFor = (atMs: number): number | null => {
    let answer: TrackedChunk | null = trackedFloor && trackedFloor.endMs <= atMs ? trackedFloor : null;
    let consumed = 0;
    for (const entry of tracked) {
      if (entry.endMs > atMs) break;
      answer = entry;
      consumed += 1;
    }
    if (!answer) return null;
    if (consumed > 0) {
      trackedFloor = tracked[consumed - 1]!;
      tracked = tracked.slice(consumed);
    }
    return answer.sequence;
  };

  const emitUtterance = (kind: "partial" | "final", value: Record<string, unknown>): void => {
    if (baseMs === null) return;
    const rawId = value.utteranceId;
    if (typeof rawId !== "string" || !UTTERANCE_ID_SHAPE.test(rawId)) return;
    const startMs = value.startMs;
    const endMs = value.endMs;
    const text = value.text;
    if (!isElapsed(startMs) || !isElapsed(endMs) || endMs <= startMs || typeof text !== "string") return;
    const utteranceId = `${generation}_${rawId}`;
    // Minted here: the reducer drops a revision that goes backwards, and the
    // endpoint has no idea what it already told this connection.
    const revision = (revisions.get(utteranceId) ?? -1) + 1;
    if (kind === "final") revisions.delete(utteranceId);
    else revisions.set(utteranceId, revision);
    if (revisions.size > MAX_TRACKED_UTTERANCES) revisions.clear();
    handlers.onEvent({
      kind,
      utteranceId,
      revision,
      text: text.slice(0, MAX_TRANSCRIPT_CHARS),
      startMs: baseMs + startMs,
      endMs: baseMs + endMs,
    });
  };

  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      drop("dependency");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (event.type === "error") {
      // The only bit that crosses: is this the audio, or the endpoint?
      console.error(`[provider-gateway] stt stream ended: ${String(event.code ?? "unknown").slice(0, 120)}`);
      drop(event.code === "undecodable_audio" ? "input" : "dependency");
      return;
    }
    if (event.type === "partial" || event.type === "final") {
      emitUtterance(event.type, event);
      return;
    }
    if (event.type === "committed") {
      const throughMs = event.throughMs;
      if (baseMs === null || !isElapsed(throughMs)) return;
      const sequence = coverageFor(baseMs + throughMs);
      if (sequence === null || sequence <= coveredThroughSequence) return;
      coveredThroughSequence = sequence;
      handlers.onEvent({ kind: "coverage", coveredThroughSequence: sequence });
    }
    // An unknown type is a newer endpoint saying something we do not need.
  };

  response.setEncoding("utf8");
  response.on("data", (piece: string) => {
    if (closed) return;
    pending += piece;
    for (let cut = pending.indexOf("\n"); cut >= 0 && !closed; cut = pending.indexOf("\n")) {
      const line = pending.slice(0, cut);
      pending = pending.slice(cut + 1);
      handleLine(line);
    }
    // The cap is on ONE unterminated line, checked after the complete ones are
    // consumed: a burst of small events can arrive in a single read, and a
    // dozen of those is not the same thing as an endpoint that never sends a
    // newline.
    if (!closed && pending.length > MAX_EVENT_LINE_CHARS) drop("dependency");
  });
  response.on("error", () => drop("dependency"));
  response.on("end", () => {
    resolveEnded();
    // A stream that ends on its own before finish is an outage, not an answer.
    if (!finishing) drop("dependency");
  });
  request.on("error", () => drop("dependency"));
  input.signal.addEventListener(
    "abort",
    () => {
      closed = true;
      resolveEnded();
      request.destroy();
      response.destroy();
    },
    { once: true },
  );

  const write = (bytes: Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed || request.destroyed) {
        reject(new Error("Streaming transcription session is closed."));
        return;
      }
      // The callback fires when the bytes are flushed, so awaiting it IS the
      // backpressure the connection already bounds with its send deadline.
      request.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve()));
    });

  const session = {
    async initialize(initialization: GatewayAudioStreamInitialization): Promise<void> {
      if (initialization.initializationSegment.byteLength === 0) return;
      await write(initialization.initializationSegment);
    },
    async send(chunk: GatewayAudioChunkFrame): Promise<void> {
      await write(chunk.audio);
      // Recorded only once the bytes are gone, so coverage can never name a
      // chunk the endpoint has not actually heard.
      baseMs ??= chunk.startMs;
      lastSentSequence = chunk.sequence;
      tracked.push({ sequence: chunk.sequence, endMs: chunk.endMs });
      if (tracked.length > MAX_TRACKED_CHUNKS) trackedFloor = tracked.shift() ?? trackedFloor;
    },
    async finish(): Promise<void> {
      if (closed) return;
      finishing = true;
      await new Promise<void>((resolve) => request.end(() => resolve()));
      // Wait for the tail the endpoint still owes, but not indefinitely: an
      // endpoint that never finishes must not hold the meeting's Stop, and the
      // chunks it never covered are still on disk for the segmented queue to
      // drain. The ceiling keeps this inside the connection's own send deadline,
      // so a generous endpoint timeout cannot turn a slow tail into a failure.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(endpoint.timeoutMs, MAX_FINISH_WAIT_MS));
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      closed = true;
      request.destroy();
      response.destroy();
    },
    close(): void {
      if (closed) return;
      teardown();
    },
  };

  return {
    session,
    accepted: {
      owner: input.owner,
      generation,
      // Never higher than what the host proved it persisted: a fresh decode has
      // no memory of the audio before this connection.
      acceptedResumeFromSequence: input.requestedResumeFromSequence,
    },
  };
}

/**
 * Build the injectable port, or `null` when this deployment has not opted in.
 *
 * `capabilities` deliberately ignores the authenticated identity: which endpoint
 * this deployment runs is a property of the deployment, not of the tenant asking.
 */
export function createGatewayAudioStreamingPort(
  env: NodeJS.ProcessEnv = process.env,
): GatewayAudioStreamingPort | null {
  const endpoint = resolveGatewayAudioStreamingEndpoint(env);
  if (!endpoint) return null;
  const capabilities = createGatewayAudioCapabilityCache(endpoint);
  return {
    capabilities(_auth: GatewayAuthContext) {
      return capabilities();
    },
    async open(
      input: GatewayAudioStreamOpenInput,
      handlers: GatewayAudioStreamHandlers,
    ): Promise<GatewayAudioStreamOpenResult> {
      const request = await openUpstream(endpoint, input);
      const response = await awaitResponse(request, endpoint.timeoutMs, input.signal);
      const contentType = String(response.headers["content-type"] ?? "");
      if (response.statusCode !== 200 || !contentType.startsWith("application/x-ndjson")) {
        console.error(`[provider-gateway] stt stream refused: ${response.statusCode} ${contentType.slice(0, 80)}`);
        response.resume();
        request.destroy();
        // A status is a fact about the endpoint, so this is the dependency class
        // and the connection closes 1011 — the caller keeps its retry budget.
        throw new Error("The streaming transcription endpoint refused the session.");
      }
      return createSession(endpoint, input, handlers, request, response, `g${randomUUID().replace(/-/g, "")}`);
    },
  };
}
