/**
 * ADR-035 D10 — transcription is two strategies behind one port, and WHICH one
 * is a property of the endpoint rather than of the host.
 *
 * ## What it owns
 *
 * The shape of the two implementations, the wire shape of a streaming delta, and
 * the one function that chooses between them. It owns no connection, no upload
 * and no state; host adapters own the connection, while `transcriptionQueue.ts`
 * goes on owning retry, bounds and gaps for the segmented path.
 *
 * ## Why the choice is the endpoint's and not the host's
 *
 * D1b says a meeting captured in the browser must survive exactly as one
 * captured on the desktop does, and the way that promise breaks is never a
 * decision to break it — it is a per-host branch that looked local. "Streaming
 * on the desktop, upload in the browser" would be that branch: same endpoint,
 * two experiences, and the browser's the worse one, which is the ADR-029 failure
 * this repo keeps paying for. So `selectTranscriptionMode` takes an endpoint
 * description and NOTHING else. There is no host argument to pass, which is a
 * cheaper guarantee than a rule saying not to pass one.
 *
 * ## Why a streaming endpoint must still accept an upload
 *
 * Because D10's durability clause is that "a dropped connection costs a
 * reconnect, not a meeting", and what makes that true is the queue replaying the
 * chunks the stream never acknowledged — over the ordinary upload path, from the
 * audio already on disk. An endpoint that can only stream has no way to be
 * replayed to, so `transcribe` is on both variants: the streaming one is the
 * segmented one plus a connection, never instead of it.
 *
 * ## Invariants
 *
 * 1. **An unrecognised or absent description is `segmented`.** The fallback path
 *    always works; guessing that an endpoint streams and being wrong costs a
 *    meeting its live text and a user their trust in the surface.
 * 2. **Streaming is the whole D10 contract, not one transport flag.** A held
 *    connection that does not emit partial results or does not own utterance
 *    boundaries stays on the segmented strategy. Calling it streaming would
 *    switch away from the 20-second policy without supplying the two facts that
 *    make that switch safe and visible.
 * 3. **Nothing here decides unit boundaries.** A fully capable streaming
 *    endpoint decides its own and `chunkLedger.ts` bounds them; a segmented one
 *    takes the policy. This module would be a third opinion.
 */
import { DEFAULT_MEETING_UNIT_POLICY, type MeetingUnitPolicy } from './chunkLedger.js';

export type MeetingTranscriptionMode = 'streaming' | 'segmented';

/**
 * What an endpoint says it can do, normalized.
 *
 * Three facts rather than one flag because they are separately true and a
 * surface has to say which promise the user has (ADR-028): an endpoint can hold
 * a connection without emitting anything mid-utterance, in which case text still
 * arrives a sentence at a time and §6's "text appears while the sentence is
 * still being spoken" is not met however the connection is described.
 */
export interface MeetingEndpointTranscription {
  /** The endpoint accepts a held connection and returns results over it. */
  readonly streaming: boolean;
  /** It emits incremental deltas mid-utterance, not only completed ones. */
  readonly partialResults: boolean;
  /** It decides utterance boundaries itself — voice activity, or a model judging the thought complete. */
  readonly serverBoundaries: boolean;
}

/** Invariant 1's answer, and what an endpoint that never said anything gets. */
export const SEGMENTED_ENDPOINT: MeetingEndpointTranscription = {
  streaming: false,
  partialResults: false,
  serverBoundaries: false,
};

/**
 * Read an endpoint's advertised capabilities into the three facts above.
 *
 * Deliberately generous about SHAPE and strict about MEANING: the same endpoint
 * document is read by both hosts, so the parsing has to live in one place or the
 * two will drift into disagreeing about what the same server can do — which is
 * the per-host branch this module exists to prevent, arrived at by accident.
 * Anything unrecognised is `SEGMENTED_ENDPOINT` (invariant 1).
 */
export function describeTranscriptionEndpoint(advertised: unknown): MeetingEndpointTranscription {
  if (!advertised || typeof advertised !== 'object') return SEGMENTED_ENDPOINT;
  const source = advertised as Record<string, unknown>;
  const flags = collectFlags(source);
  const streaming = readBoolean(source, ['streaming', 'stream', 'realtime', 'live'])
    ?? (flags.has('streaming') || flags.has('realtime') || flags.has('live'));
  if (!streaming) return SEGMENTED_ENDPOINT;
  const partialResults = readBoolean(source, ['partialResults', 'partial_results', 'interimResults', 'interim_results'])
    // A held connection may still emit final utterances only. Missing means
    // false because inventing partials makes the surface promise mid-sentence
    // text that the endpoint never said it can provide.
    ?? (
      flags.has('partial_results')
      || flags.has('interim_results')
      || flags.has('incremental')
      || flags.has('deltas')
    );
  const serverBoundaries = readBoolean(source, ['serverBoundaries', 'server_boundaries', 'serverVad', 'server_vad', 'vad'])
    ?? (
      flags.has('server_boundaries')
      || flags.has('server_vad')
      || flags.has('vad')
      || flags.has('semantic_vad')
    );
  return { streaming: true, partialResults, serverBoundaries };
}

/**
 * D10 — which strategy this endpoint gets.
 *
 * One argument, and that is the whole of D1b's protection here: there is no host
 * to branch on. Both surfaces hand this the same description of the same
 * endpoint and get the same answer, or they are not talking to the same
 * endpoint. All three facts are required: a bare `streaming: true` means only
 * that a connection can be held, not that the D10 live strategy exists.
 */
export function selectTranscriptionMode(endpoint: MeetingEndpointTranscription): MeetingTranscriptionMode {
  return hasStreamingContract(endpoint) ? 'streaming' : 'segmented';
}

/**
 * ADR-028 / §6 — may the surface promise text while the sentence is still being
 * spoken?
 *
 * It is phrased as a separate claim for surfaces, but it is backed by the same
 * complete contract as strategy selection. A held connection with partials but
 * no server-owned boundaries is still the segmented strategy; promising live
 * text for a strategy we refuse to run would be as misleading as selecting it.
 */
export function liveTextExpected(endpoint: MeetingEndpointTranscription): boolean {
  return hasStreamingContract(endpoint);
}

/** D10's indivisible endpoint contract, kept in one predicate so the two user-facing answers cannot drift. */
function hasStreamingContract(endpoint: MeetingEndpointTranscription): boolean {
  return endpoint.streaming && endpoint.partialResults && endpoint.serverBoundaries;
}

/**
 * One incremental result from a streaming endpoint.
 *
 * `utteranceId` is the endpoint's own name for the stretch of speech this
 * belongs to, and it is what makes a REVISION expressible: two deltas with one
 * id are the same words getting better, not two things that were said.
 *
 * `acknowledgedThroughSequence` is the durability half, and it is the field that
 * makes "a dropped connection costs a reconnect, not a meeting" checkable: it
 * says which of our chunks the endpoint has actually consumed, so everything
 * after it is ours to replay. A host whose endpoint cannot report it leaves it
 * out and the coverage is derived from `endMs` instead.
 */
export interface MeetingTranscriptionDelta {
  readonly utteranceId: string;
  readonly text: string;
  /** Elapsed milliseconds from the start of the capture, like a chunk's range. */
  readonly startMs: number;
  readonly endMs: number;
  /** The endpoint says this utterance is complete and will not be revised again. */
  readonly final: boolean;
  readonly acknowledgedThroughSequence?: number;
}

/** The upload path: today's `/v1/audio/transcriptions` POST, one unit per request. */
export interface MeetingSegmentedTranscription {
  readonly mode: 'segmented';
  transcribe(audio: Uint8Array, mimeType: string): Promise<string> | string;
}

/** A connection that is open for the length of a meeting, or until it is not. */
export interface MeetingTranscriptionStream {
  /** Push one durability chunk. Called AFTER the bytes are on the device, never instead. */
  send(audio: Uint8Array, sequence: number): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface MeetingStreamHandlers {
  onDelta(delta: MeetingTranscriptionDelta): void;
  /** The connection is gone. Whatever it did not acknowledge is the queue's now. */
  onDrop(error?: unknown): void;
}

/**
 * The streaming path — which is the segmented path plus a connection, for the
 * replay reason in the header.
 */
export interface MeetingStreamingTranscription extends Omit<MeetingSegmentedTranscription, 'mode'> {
  readonly mode: 'streaming';
  open(handlers: MeetingStreamHandlers): Promise<MeetingTranscriptionStream> | MeetingTranscriptionStream;
}

export type MeetingTranscription = MeetingSegmentedTranscription | MeetingStreamingTranscription;

/**
 * The unit policy a mode implies.
 *
 * The segmented strategy asks for about a target's worth of audio per request.
 * The streaming one asks for nothing — its boundaries come from the endpoint —
 * so what it gets is the CEILING: a run of chunks may not grow past this
 * whatever the endpoint does or fails to do, which is what stops a stream that
 * stops speaking from leaving an hour of audio in an unclaimed run.
 */
export function unitPolicyFor(
  mode: MeetingTranscriptionMode,
  policy: MeetingUnitPolicy = DEFAULT_MEETING_UNIT_POLICY,
): MeetingUnitPolicy {
  if (mode === 'segmented') return policy;
  return { ...policy, targetMs: policy.maxMs };
}

/** A declared boolean under any of these names, or `undefined` if none is declared. */
function readBoolean(source: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'boolean') return value;
    // A string is what a JSON-ish capability document tends to carry, and only
    // the two unambiguous spellings are read — "maybe" is not a capability.
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/**
 * The capability WORDS an endpoint listed, lower-cased and de-punctuated.
 *
 * Endpoints advertise the same facts as flags (`{ streaming: true }`) or as a
 * list (`{ capabilities: ["streaming", "server_vad"] }`) about equally often,
 * and a reader that understood only one shape would call half of the streaming
 * endpoints segmented — which is invariant 1 being satisfied in the letter and
 * missed in the spirit.
 */
function collectFlags(source: Record<string, unknown>): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const key of ['capabilities', 'features', 'modes', 'supports', 'supported']) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') flags.add(entry.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    }
  }
  return flags;
}
