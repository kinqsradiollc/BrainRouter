/**
 * ADR-035 D10 — the browser's client for the gateway's persistent-audio
 * protocol: one meeting, one connection, deltas coming back while somebody is
 * still speaking.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a transport. It carries durability chunks that are ALREADY on this
 * device up to the gateway and hands transcript frames back down unread. It
 * decides nothing about the transcript: `streamingTranscript.ts` in core is the
 * only thing that says what a partial, a final or a coverage proof means, and
 * this file never inspects an event's fields — `onEvent` takes `unknown` for
 * exactly that reason, so a second, laxer reader cannot grow here.
 *
 * ## Why the credential is in a frame and not in the URL
 *
 * A browser `WebSocket` cannot set an `Authorization` header, and the two usual
 * workarounds are both wrong: a token in the query string is written to every
 * proxy and access log on the way, and a `Sec-WebSocket-Protocol` smuggle is the
 * same string in a different header. The gateway refuses an upgrade carrying any
 * query at all and authenticates the FIRST FRAME instead, under an attach
 * deadline. So the socket is opened unauthenticated, the bearer is sent as the
 * first message, and nothing else may be sent until `attached` comes back.
 *
 * ## The frames
 *
 * Text out: the attach frame, then `{"type":"finish"}` when the recording ends.
 * Binary out: `0x01` + container initialization bytes (once), then `0x02` + u32
 * sequence + u64 startMs + u64 endMs + audio, big-endian, one frame per D9
 * durability chunk and strictly contiguous from whatever the endpoint accepted
 * as already covered.
 *
 * Text in: `{"type":"attached", …}`, `{"type":"transcript.event", event}`,
 * `{"type":"finished"}`.
 *
 * ## The close codes are copied, and they have to be
 *
 * The gateway's table lives in its own package, which a browser bundle cannot
 * import. The numbers below mirror `audio-streaming-protocol.ts`'s
 * `GATEWAY_AUDIO_STREAM_CLOSE` and exist here only to turn a code into a
 * SENTENCE — golden rule 23's "say why the better path did not run". A code this
 * table does not know still produces a fallback and still says something true;
 * the mapping degrades to the generic sentence rather than to silence.
 */
import type {
  MeetingTranscriptCommittedCheckpoint,
  MeetingTranscriptionLatencyMode,
  MeetingTranscriptionStream,
  MeetingTranscriptionStreamChunk,
  MeetingTranscriptionStreamInitialization,
} from "@kinqs/brainrouter-core/meetings";

import { meetingStreamUrl } from "./transcriptionEndpoint";

const INITIALIZATION_FRAME_KIND = 0x01;
const AUDIO_FRAME_KIND = 0x02;
const AUDIO_FRAME_HEADER_BYTES = 1 + 4 + 8 + 8;

/**
 * Whether a drop can be waited out or is a verdict on this recording.
 *
 * The same distinction D7 draws for the batch path, and for the same reason: an
 * outage costs nothing but time, while a verdict that is mistaken for an outage
 * reconnects for ever against an endpoint that will never accept these bytes.
 */
export type CaptureStreamDropKind = "outage" | "refused";

export interface CaptureStreamDrop {
  readonly kind: CaptureStreamDropKind;
  /** A sentence a person can act on, not a code. */
  readonly reason: string;
}

/** Mirrors the gateway's `GATEWAY_AUDIO_STREAM_CLOSE`; see the module header. */
const CLOSE_REASONS: Readonly<Record<number, CaptureStreamDrop>> = {
  1000: { kind: "outage", reason: "the connection was closed" },
  1002: { kind: "refused", reason: "this browser and the server disagreed about the protocol" },
  1006: { kind: "outage", reason: "the connection dropped" },
  1008: { kind: "refused", reason: "the server rejected this recording's details" },
  1009: { kind: "refused", reason: "a piece of the audio was too large to send" },
  1011: { kind: "outage", reason: "the transcription service ended the session" },
  1013: { kind: "outage", reason: "the transcription service is at capacity" },
  4401: { kind: "refused", reason: "this browser's sign-in was not accepted for live transcription" },
  4408: { kind: "outage", reason: "the server did not accept the connection in time" },
  4409: { kind: "refused", reason: "another connection is already streaming this recording" },
  4422: { kind: "refused", reason: "the server could not decode this recording's audio" },
};

const UNKNOWN_DROP: CaptureStreamDrop = { kind: "outage", reason: "the connection ended unexpectedly" };

/** The drop a close code means. Unknown codes are treated as an outage — see the header. */
export function captureStreamDrop(code: number): CaptureStreamDrop {
  return CLOSE_REASONS[code] ?? UNKNOWN_DROP;
}

/**
 * The browser `WebSocket` reduced to what this client uses.
 *
 * A port rather than the global so a test can drive an attach deadline, an
 * out-of-order frame and a mid-meeting close without a browser — the three
 * behaviours that decide whether a meeting keeps its text.
 */
export interface CaptureStreamSocket {
  binaryType: string;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: (() => void) | null;
}

export type CaptureStreamSocketFactory = (url: string) => CaptureStreamSocket;

export interface CaptureStreamHandlers {
  /** Handed straight to core's reducer; nothing here reads it. */
  onEvent(event: unknown): void;
  /** Called at most once, and never for a close this host asked for. */
  onDrop(drop: CaptureStreamDrop): void;
}

export interface CaptureStreamOptions {
  readonly baseUrl: string;
  /** JWT or API key. The gateway authenticates this in the attach frame. */
  readonly token: string;
  /** The workspace the capture was frozen under at Record — never the switcher's current one. */
  readonly orgId: string;
  readonly sessionId: string;
  readonly mimeType: string;
  /** BCP-47, or absent to let the endpoint detect it. */
  readonly language?: string;
  readonly latencyMode: MeetingTranscriptionLatencyMode;
  /** The last ATOMICALLY PERSISTED token, or null. Never a reducer result the host has not written down. */
  readonly resumeFrom: MeetingTranscriptCommittedCheckpoint | null;
  readonly handlers: CaptureStreamHandlers;
  readonly socket?: CaptureStreamSocketFactory;
}

/**
 * A live connection, plus the one fact the caller cannot know without asking:
 * how much of the recording the endpoint says it already has.
 *
 * `acceptedThroughSequence` is the ADAPTER's answer and it may be lower than the
 * checkpoint that was requested — never higher, which the gateway itself
 * refuses. The host replays every durability chunk after it, from the store, so
 * a reconnect is paid for in bytes already on disk rather than in lost speech.
 */
export interface CaptureStream extends MeetingTranscriptionStream {
  readonly acceptedThroughSequence: number | null;
}

/** `0x01` + the container initialization segment, which may legitimately be empty. */
export function encodeInitializationFrame(initialization: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + initialization.byteLength);
  frame[0] = INITIALIZATION_FRAME_KIND;
  frame.set(initialization, 1);
  return frame;
}

/** `0x02` + u32 sequence + u64 startMs + u64 endMs + audio, big-endian. */
export function encodeAudioFrame(chunk: MeetingTranscriptionStreamChunk): Uint8Array {
  const frame = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + chunk.audio.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = AUDIO_FRAME_KIND;
  view.setUint32(1, chunk.sequence, false);
  view.setBigUint64(5, BigInt(Math.round(chunk.startMs)), false);
  view.setBigUint64(13, BigInt(Math.round(chunk.endMs)), false);
  frame.set(chunk.audio, AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Open one authenticated persistent session, or reject.
 *
 * Rejects rather than resolving into a half-open stream, because the caller's
 * answer to "there is no live path" is a VISIBLE fallback to segmented upload,
 * and a stream object that silently swallows every chunk is the invisible
 * version of the same outcome.
 */
export async function openCaptureStream(options: CaptureStreamOptions): Promise<CaptureStream> {
  const factory = options.socket
    ?? ((url: string) => new WebSocket(url) as unknown as CaptureStreamSocket);
  const socket = factory(meetingStreamUrl(options.baseUrl));
  socket.binaryType = "arraybuffer";

  /** Set by `close()`, so a socket this host shut down is never reported as a drop. */
  let closing = false;
  let dropped = false;
  let attached = false;
  const drop = (code: number): void => {
    if (dropped || closing) return;
    dropped = true;
    options.handlers.onDrop(captureStreamDrop(code));
  };

  return await new Promise<CaptureStream>((resolve, reject) => {
    /** Resolved by `finish`; a close before it lands is still a finished stream. */
    let finished: (() => void) | null = null;
    /**
     * Whether the endpoint has said its last word — by answering `finished`, or
     * by the socket going away, which is the same fact arriving less politely.
     *
     * It is a FLAG and not just the callback because the two orderings both
     * happen: a `close()` that races a socket already gone would otherwise wait
     * on a resolver nothing will ever call, and the caller of `close()` is Stop.
     */
    let ended = false;
    const end = (): void => {
      ended = true;
      finished?.();
    };

    socket.onopen = () => {
      // The credential-bearing first frame. `undefined` fields are omitted
      // rather than sent as null: the gateway rejects an attach with any key it
      // does not know, and `language: undefined` serializes to no key at all.
      socket.send(JSON.stringify({
        type: "attach",
        bearer: options.token,
        requestedOrgId: options.orgId,
        sessionId: options.sessionId,
        mimeType: options.mimeType,
        language: options.language ?? null,
        latencyMode: options.latencyMode,
        resumeFromSequence: options.resumeFrom?.acknowledgedThroughSequence ?? null,
      }));
    };

    socket.onerror = () => {
      // A browser `WebSocket` error carries nothing usable and is always
      // followed by a close, which is where the code is. Nothing to do here but
      // not throw.
    };

    socket.onclose = (event) => {
      if (!attached) {
        drop(event.code);
        reject(new Error(captureStreamDrop(event.code).reason));
        return;
      }
      end();
      drop(event.code);
    };

    socket.onmessage = (message) => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (frame.type === "transcript.event") {
        options.handlers.onEvent(frame.event);
        return;
      }
      if (frame.type === "finished") {
        end();
        return;
      }
      if (frame.type !== "attached" || attached) return;
      attached = true;
      const accepted = frame.acceptedResumeFromSequence;
      resolve({
        acceptedThroughSequence: typeof accepted === "number" && Number.isSafeInteger(accepted) && accepted >= 0
          ? accepted
          : null,
        initialize(input: MeetingTranscriptionStreamInitialization): void {
          socket.send(encodeInitializationFrame(input.initializationSegment));
        },
        send(chunk: MeetingTranscriptionStreamChunk): void {
          socket.send(encodeAudioFrame(chunk));
        },
        /**
         * End of audio, said explicitly.
         *
         * `finish` is what makes the endpoint seal its last utterance, so this
         * waits for the answer — but only for the answer, with no timer of its
         * own: the socket closing IS the other answer, and one of the two always
         * arrives. The caller does not hold a person's Stop button behind this.
         */
        async close(): Promise<void> {
          if (closing) return;
          closing = true;
          if (ended) {
            socket.close();
            return;
          }
          const settled = new Promise<void>((done) => {
            finished = done;
          });
          try {
            socket.send(JSON.stringify({ type: "finish" }));
          } catch {
            socket.close();
            return;
          }
          await settled;
          socket.close();
        },
      });
    };
  });
}
