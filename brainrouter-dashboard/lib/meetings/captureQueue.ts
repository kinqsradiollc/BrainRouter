/**
 * ADR-035 D3/D5/D7 — the dashboard's half of the shared transcription queue.
 *
 * The scheduler is NOT here. It is `MeetingTranscriptionQueue` in
 * `@kinqs/brainrouter-core/meetings`, and it owns everything with a rule in it:
 * bounded concurrency, the backoff schedule, which failures cost a retry, when a
 * segment becomes a stated gap, and how a queue rebuilt over a recovered session
 * knows what is left to do. D1b is explicit that those are shared, and a second
 * copy in the browser would be a second retry rule that drifts from the
 * desktop's until the two hosts disagree about when a meeting is out of retries.
 *
 * What lives here is the three ports the scheduler asks a host for, and nothing
 * else:
 *
 * - `readSegment` — one chunk out of OPFS/IndexedDB, handed to the SHARED
 *   `createSegmentAudioReader`, which puts the container header back in front of
 *   it because a `MediaRecorder` timeslice chunk after the first is a fragment
 *   rather than a file. The framing used to live here, in the browser; a host
 *   without it transcribes segment 0 and nothing else, so under D1b it belongs
 *   in core where neither host can be the one that lacks it. What is left here
 *   is the one genuinely browser-shaped step: `Blob` to `Uint8Array`.
 * - `transcribe` — one POST to `/v1/audio/transcriptions`, carrying the HTTP
 *   status on the thrown error so the shared classifier can tell "this audio was
 *   rejected" (counts, becomes a gap) from "the endpoint is down" (D7: costs no
 *   retry budget).
 * - `persist` — the whole session back into the capture manifest, so the next
 *   load of this origin can reconstruct the queue exactly where it stopped.
 *
 * That last one is where the honest boundary is. A renderer-owned queue dies
 * with the tab (ADR-035 open question 3 names this), and a browser has no host
 * process to hand it to. So the browser's answer is not "the queue survives" —
 * it is "the queue holds no state worth surviving". The scheduler recomputes its
 * work list from the persisted session on every pass, so a tab that is killed
 * loses a scheduler and not a position: the next load rebuilds one over the same
 * record and carries on.
 */
import {
  createMeetingTranscriptionQueue,
  createSegmentAudioReader,
  isTerminalCaptureStatus,
  type MeetingCaptureSession,
  type MeetingTranscriptionPorts,
  type MeetingTranscriptionQueue,
} from "@kinqs/brainrouter-core/meetings";

import { serializeCapturePayload } from "./capturePayload";
import type { MeetingCaptureStore } from "./captureStore";

/** What both hosts' `MediaRecorder` produces unless it negotiated something else. */
export const DEFAULT_CAPTURE_MIME_TYPE = "audio/webm";

/** One segment of audio in, its text out. The seam a test replaces. */
export type SegmentTranscriber = (audio: Uint8Array, mimeType: string) => Promise<string>;

/**
 * An HTTP failure the shared classifier can read.
 *
 * `status` is the whole reason this class exists: `classifyTranscriptionFailure`
 * treats 408/429/502/503/504 as the endpoint declining to serve (D7 — the same
 * bytes will transcribe once it recovers, so no retry budget is spent) and
 * everything else as a verdict on this audio. Throwing a bare `Error` would make
 * a 503 during a sidecar restart permanently mark good audio as a gap.
 */
export class SegmentTranscriptionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SegmentTranscriptionError";
    this.status = status;
  }
}

export interface SttTranscriberOptions {
  readonly baseUrl: string;
  /** JWT or API key; absent on an unauthenticated dev origin. */
  readonly token?: string;
  /** BCP-47 tag, or absent/`"auto"` to let the endpoint detect it. */
  readonly language?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The STT call, per segment.
 *
 * Deliberately no client-side size ceiling. D3's third consequence is that "the
 * 40 MB body limit stops being a ceiling on meeting length, because nothing ever
 * posts an hour of audio in one request" — a twenty-second segment is a few
 * hundred kilobytes, so a refusal here could only ever be wrong. The ceiling
 * still applies to the import/paste path (D8), where a user really can hand us a
 * whole file.
 */
export function createSttTranscriber(options: SttTranscriberOptions): SegmentTranscriber {
  const call = options.fetchImpl ?? fetch;
  const language = options.language && options.language !== "auto" ? options.language : undefined;
  const url = `${options.baseUrl}/v1/audio/transcriptions${language ? `?language=${encodeURIComponent(language)}` : ""}`;
  return async (audio, mimeType) => {
    const response = await call(url, {
      method: "POST",
      headers: {
        "Content-Type": mimeType || DEFAULT_CAPTURE_MIME_TYPE,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      // A `Blob` over a copy of exactly these bytes, for two reasons that both
      // matter. Sending `audio.buffer` instead would be the habit that one day
      // uploads a whole meeting because something upstream handed back a
      // subarray of a larger array. And the copy is what narrows TypeScript's
      // `Uint8Array<ArrayBufferLike>` — which may be shared-memory backed and is
      // therefore not a `BlobPart` — to a plain one, without asserting it.
      body: new Blob([new Uint8Array(audio)]),
    });
    if (!response.ok) {
      throw new SegmentTranscriptionError(response.status, await failureText(response));
    }
    const payload = (await response.json()) as { text?: unknown };
    return typeof payload.text === "string" ? payload.text.trim() : "";
  };
}

export interface CaptureQueueOptions {
  readonly store: MeetingCaptureStore;
  readonly session: MeetingCaptureSession;
  readonly transcribe: SegmentTranscriber;
  /** The recorder's container type, carried beside the session in the manifest. */
  readonly mimeType?: string;
  readonly title?: string;
  readonly maxInFlight?: number;
}

/**
 * Build the shared scheduler over one stored capture.
 *
 * One queue per meeting, and it is the SINGLE WRITER of that session while it
 * exists — the surface mutates through `queue.apply(...)` rather than beside it.
 * Two writers would interleave a `markDone` with an `appendSegment` and lose one
 * of them, which is the same class of defect as losing the audio, just quieter.
 */
export function createCaptureQueue(options: CaptureQueueOptions): MeetingTranscriptionQueue {
  const { store, session } = options;
  const sessionId = session.id;
  const mimeType = options.mimeType || DEFAULT_CAPTURE_MIME_TYPE;

  const ports: MeetingTranscriptionPorts = {
    // The shared reader owns everything with a rule in it — which segment needs
    // the container header, where the header ends, caching it across attempts,
    // and what a missing chunk means (a fact about THIS segment, so the queue
    // counts it and it ends as a stated gap rather than retrying forever). All
    // this host contributes is reading the bytes and turning a `Blob` into a
    // `Uint8Array`, which is the only part of it that is about being a browser.
    readSegment: createSegmentAudioReader({
      async readChunk(index) {
        const chunk = await store.readSegment(sessionId, index);
        return chunk ? new Uint8Array(await chunk.arrayBuffer()) : null;
      },
    }),
    transcribe: (audio, type) => options.transcribe(audio, type),
    async persist(next) {
      await store.setPayload(
        sessionId,
        serializeCapturePayload({
          ...(options.title ? { title: options.title } : {}),
          mimeType,
          session: next,
        }),
        // D2/D6 — `closed` is what stops a finished or discarded meeting being
        // offered back. The store cannot decide it without parsing the payload,
        // so the one definition of terminal is applied here, from the shared model.
        { closed: isTerminalCaptureStatus(next.status) },
      );
    },
  };

  return createMeetingTranscriptionQueue({
    session,
    ports,
    mimeType,
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
  });
}

/** The endpoint's own words when it has them; the status alone when it does not. */
async function failureText(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    if (body) return `Transcription failed (${response.status}): ${body.slice(0, 200)}`;
  } catch {
    // A body we cannot read is not worth failing differently over.
  }
  return `Transcription failed (${response.status}).`;
}
