/**
 * ADR-035 D10 — the desktop's half of the gateway's persistent-transcription
 * wire, as pure functions over strings and bytes.
 *
 * The gateway owns the contract (`audio-streaming-protocol.ts`): an authenticated
 * attach frame first, then one explicit container-initialization frame, then
 * ordered durability chunks, then an explicit finish. This module is that shape
 * written from the client end, and NOTHING else — no socket, no credential
 * lookup, no reconnect policy. That split is what lets every framing rule be
 * asserted against the bytes rather than against a mock: an audio frame with the
 * range in the wrong endianness is a frame the gateway closes the connection
 * over, and a test that only checked `send` was called could not tell.
 *
 * Two rules here are load-bearing beyond framing:
 *
 * - **The attach frame carries the account bearer**, so `meetingStreamUrl`
 *   refuses to build a `ws://` URL for anything but loopback. It is the same
 *   rule `meetingsBridge.ts` applies to the batch POST, restated at the one
 *   other place a credential leaves this process.
 * - **A close code is a fact about which side failed**, and the host acts on it
 *   differently: undecodable audio must stop the stream for good and let the
 *   segmented path state the gap (D7's distinction, which the gateway spells
 *   4422 for exactly this reason), while an endpoint failure is worth a
 *   reconnect from audio that is already on disk.
 */
import type { MeetingTranscriptionLatencyMode } from '@kinqs/brainrouter-core/meetings';

/** The gateway's authenticated capability document, on the same base as the batch POST. */
export const MEETING_TRANSCRIPTION_CAPABILITIES_PATH = '/v1/audio/transcriptions/capabilities';

/** The gateway's WebSocket upgrade path. Query parameters are refused there, so there are none. */
export const MEETING_TRANSCRIPTION_STREAM_PATH = '/v1/audio/transcriptions/stream';

/** The only control frame a client sends. The gateway requires exactly this one key. */
export const MEETING_STREAM_FINISH_FRAME = JSON.stringify({ type: 'finish' });

const INITIALIZATION_FRAME_KIND = 0x01;
const AUDIO_FRAME_KIND = 0x02;
const AUDIO_FRAME_HEADER_BYTES = 1 + 4 + 8 + 8;

/** Same list `meetingsBridge.ts` uses: where an http bearer is acceptable because it never leaves the machine. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * What a close code means to the HOST, which is not the same question the code
 * answers for the gateway.
 *
 * - `finished` — the endpoint acknowledged the finish; the tail is covered.
 * - `audio` — these bytes will never decode (4422). Reconnecting would replay
 *   the same undecodable audio for ever, so streaming stops and the segmented
 *   path takes it: worst case a stated gap, which is a fact a person can act on.
 * - `endpoint` — the far side failed or is busy. The chunks are on disk, so this
 *   costs a reconnect (D10) and nothing else.
 * - `refused` — this connection was not admitted at all: authentication, a
 *   malformed request, a frame we should not have sent. Retrying repeats it, so
 *   the host degrades to segmented and SAYS so (golden rule 23).
 */
export type MeetingStreamCloseKind = 'finished' | 'audio' | 'endpoint' | 'refused';

/** The subset of `GATEWAY_AUDIO_STREAM_CLOSE` this host has to tell apart. */
const CLOSE_KINDS = new Map<number, MeetingStreamCloseKind>([
  [1000, 'finished'],
  [4422, 'audio'],
  [1011, 'endpoint'],
  [1013, 'endpoint'],
  [4409, 'endpoint'],
  [4401, 'refused'],
  [4408, 'refused'],
  [1002, 'refused'],
  [1008, 'refused'],
  [1009, 'refused'],
]);

/**
 * An unrecognized code is an ENDPOINT failure, deliberately.
 *
 * It is the same bias `audio-streaming-protocol.ts` states for its own default
 * and `transcriptionQueue.ts` states for HTTP statuses: a mistaken outage only
 * delays text that the reconnect then produces, while a mistaken verdict about
 * the audio throws away a live path that was working.
 */
export function classifyMeetingStreamClose(code: number): MeetingStreamCloseKind {
  return CLOSE_KINDS.get(code) ?? 'endpoint';
}

/**
 * This deployment cannot offer a live stream at all, and here is the sentence to
 * say about it.
 *
 * Distinct from an ordinary connection failure because the ANSWER is different:
 * a signed-out desktop, a plain-http account host, or a recorder MIME the
 * gateway will not accept are all permanent for this capture, so retrying them
 * four times would only delay the sentence a person needs (golden rule 23).
 */
export class MeetingStreamUnavailableError extends Error {
  /** Structural marker, so a caller can recognize it without importing the class. */
  readonly streamUnavailable = true;

  constructor(readonly notice: string) {
    super(notice);
    this.name = 'MeetingStreamUnavailableError';
  }
}

export interface MeetingStreamAttachInput {
  readonly bearer: string;
  readonly requestedOrgId: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly language: string | null;
  readonly latencyMode: MeetingTranscriptionLatencyMode;
  /** The last checkpoint the host persisted, or null to start the meeting from its first chunk. */
  readonly resumeFromSequence: number | null;
}

/**
 * The credential-bearing first frame.
 *
 * The gateway parses it with an exact key set, so this object is written out in
 * full rather than with optional members spread in: an omitted `language` and a
 * null one are the same thing there, and an EXTRA key fails the whole frame
 * closed.
 */
export function encodeMeetingStreamAttach(input: MeetingStreamAttachInput): string {
  return JSON.stringify({
    type: 'attach',
    bearer: input.bearer,
    requestedOrgId: input.requestedOrgId,
    sessionId: input.sessionId,
    mimeType: input.mimeType,
    language: input.language,
    latencyMode: input.latencyMode,
    resumeFromSequence: input.resumeFromSequence,
  });
}

/**
 * The container bootstrap, which is explicit even when it is empty.
 *
 * A unit that starts at chunk 0 already carries the recording's own header, so
 * the prefix is empty there and prepending it would decode the meeting's first
 * seconds twice. A stream RESUMED at chunk 412 has no header in front of it, and
 * this frame is what puts one back — the same rule `segmentAudio.ts` applies to
 * a batch upload, because it is the same decoder on the other end.
 */
export function encodeMeetingStreamInitialization(initializationSegment: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + initializationSegment.byteLength);
  frame[0] = INITIALIZATION_FRAME_KIND;
  frame.set(initializationSegment, 1);
  return frame;
}

export interface MeetingStreamAudioFrame {
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly audio: Uint8Array;
}

/**
 * One durability chunk: `0x02`, a big-endian u32 sequence, two big-endian u64
 * elapsed milliseconds, then the exact bytes already on disk.
 *
 * The range is the LEDGER's, never a clock read here. The gateway rejects a
 * non-monotonic or over-long range, and a host that timed the frame instead of
 * reading the record would produce one the moment a disk write ran slow.
 */
export function encodeMeetingStreamAudio(chunk: MeetingStreamAudioFrame): Uint8Array {
  if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || chunk.sequence > 0xffff_ffff) {
    throw new Error('A meeting stream chunk sequence must be an unsigned 32-bit integer.');
  }
  if (!Number.isSafeInteger(chunk.startMs) || chunk.startMs < 0 || !Number.isSafeInteger(chunk.endMs)
    || chunk.endMs <= chunk.startMs) {
    throw new Error('A meeting stream chunk must cover a positive elapsed range.');
  }
  if (!chunk.audio.byteLength) throw new Error('A meeting stream chunk must carry audio.');
  const frame = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + chunk.audio.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame[0] = AUDIO_FRAME_KIND;
  view.setUint32(1, chunk.sequence, false);
  view.setBigUint64(5, BigInt(chunk.startMs), false);
  view.setBigUint64(13, BigInt(chunk.endMs), false);
  frame.set(chunk.audio, AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

export interface MeetingStreamAttachedMessage {
  readonly type: 'attached';
  readonly sessionId: string;
  readonly generation: string;
  /**
   * The checkpoint the gateway and its adapter actually accepted, which is never
   * higher than the one this host asked for. Everything after it is replayed
   * from disk.
   */
  readonly acceptedResumeFromSequence: number | null;
  readonly latencyMode: string;
}

export interface MeetingStreamEventMessage {
  readonly type: 'transcript.event';
  /** Handed on unvalidated: `reduceStreamingTranscript` is the one validator, and a second one would drift from it. */
  readonly event: unknown;
}

export interface MeetingStreamFinishedMessage {
  readonly type: 'finished';
}

export type MeetingStreamMessage =
  | MeetingStreamAttachedMessage
  | MeetingStreamEventMessage
  | MeetingStreamFinishedMessage;

/** A server frame that is not one of the three, or is not JSON at all, is dropped rather than thrown over. */
export function parseMeetingStreamMessage(raw: string): MeetingStreamMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.type === 'finished') return { type: 'finished' };
  if (source.type === 'transcript.event') {
    return 'event' in source ? { type: 'transcript.event', event: source.event } : null;
  }
  if (source.type !== 'attached') return null;
  const sessionId = source.sessionId;
  const generation = source.generation;
  const latencyMode = source.latencyMode;
  const accepted = source.acceptedResumeFromSequence;
  if (typeof sessionId !== 'string' || !sessionId || typeof generation !== 'string' || !generation
    || typeof latencyMode !== 'string' || !latencyMode) {
    return null;
  }
  if (accepted !== null && (typeof accepted !== 'number' || !Number.isSafeInteger(accepted) || accepted < 0)) {
    return null;
  }
  return { type: 'attached', sessionId, generation, acceptedResumeFromSequence: accepted, latencyMode };
}

/**
 * The stream URL for an account base, or `null` when this host must not open one.
 *
 * `https` becomes `wss`; plain `http` is accepted only for loopback, because the
 * attach frame carries the account bearer and a bearer does not travel in
 * cleartext to another machine. Returning `null` is not an error state — it is
 * the segmented answer, and the caller says so out loud.
 */
export function meetingStreamUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.replace(/\/+$/, ''));
  } catch {
    return null;
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = url.pathname.replace(/\/+$/, '');
  return `${scheme}//${url.host}${base}${MEETING_TRANSCRIPTION_STREAM_PATH}`;
}

/**
 * D10 — which latency mode to ask an endpoint for.
 *
 * The ADR's judgement for D10 is "text appears while the sentence is still being
 * spoken", so the lowest-latency mode the endpoint advertises is the one that
 * answers it. The choice is bounded by what was advertised, because the gateway
 * refuses an unadvertised mode outright.
 */
export function preferredLatencyMode(
  modes: readonly MeetingTranscriptionLatencyMode[],
): MeetingTranscriptionLatencyMode | null {
  for (const candidate of ['low-latency', 'balanced', 'high-accuracy'] as const) {
    if (modes.includes(candidate)) return candidate;
  }
  return null;
}
