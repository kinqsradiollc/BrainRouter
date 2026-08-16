/**
 * ADR-035 D10 — the endpoint-owned transcription strategy contract.
 *
 * This module owns one versioned capability document and the ports selected by
 * it. The document is deliberately exact: a persistent connection is not the
 * live strategy unless it also promises partial results, server-owned
 * boundaries, coverage checkpoints, resumability, an explicit latency mode,
 * and the segmented upload fallback. Unknown versions, aliases, string
 * booleans, and partial documents all select the proven segmented path.
 *
 * A coverage checkpoint is never inferred from elapsed time, bytes received,
 * or an utterance becoming final. `streamingTranscript.ts` validates the
 * separate coverage event, and the host promotes its result to resume authority
 * only after transcript state and checkpoint persist atomically.
 */
import {
  boundedEndpointUnitPolicy,
  DEFAULT_MEETING_UNIT_POLICY,
  type MeetingUnitPolicy,
} from './chunkLedger.js';
import type { MeetingChunk } from './types.js';
import type {
  MeetingStreamingTranscriptEvent,
  MeetingTranscriptCommittedCheckpoint,
} from './streamingTranscript.js';

export type MeetingTranscriptionMode = 'streaming' | 'segmented';

export const MEETING_TRANSCRIPTION_LATENCY_MODES = Object.freeze([
  'low-latency',
  'balanced',
  'high-accuracy',
] as const);

export type MeetingTranscriptionLatencyMode = (typeof MEETING_TRANSCRIPTION_LATENCY_MODES)[number];

export interface MeetingStreamingEndpointCapabilities {
  readonly persistent: true;
  readonly partialResults: true;
  readonly serverBoundaries: true;
  readonly coverageCheckpoints: true;
  readonly resumable: true;
  readonly latencyModes: readonly MeetingTranscriptionLatencyMode[];
}

export interface MeetingSegmentedTranscriptionCapabilities {
  readonly schemaVersion: 1;
  readonly segmentedUpload: true;
  readonly streaming: null;
}

export interface MeetingStreamingTranscriptionCapabilities {
  readonly schemaVersion: 1;
  readonly segmentedUpload: true;
  readonly streaming: MeetingStreamingEndpointCapabilities;
}

export type MeetingTranscriptionCapabilities =
  | MeetingSegmentedTranscriptionCapabilities
  | MeetingStreamingTranscriptionCapabilities;

/** The immutable answer for every absent, unknown, malformed, or incomplete document. */
export const SEGMENTED_TRANSCRIPTION_CAPABILITIES: MeetingSegmentedTranscriptionCapabilities = Object.freeze({
  schemaVersion: 1,
  segmentedUpload: true,
  streaming: null,
});

/** Build a canonical, deeply frozen v1 streaming capability document. */
export function createStreamingTranscriptionCapabilities(
  latencyModes: readonly MeetingTranscriptionLatencyMode[],
): MeetingStreamingTranscriptionCapabilities {
  if (!isLatencyModeList(latencyModes)) {
    throw new Error('Streaming transcription must advertise one or more distinct supported latency modes.');
  }
  return Object.freeze({
    schemaVersion: 1,
    segmentedUpload: true,
    streaming: Object.freeze({
      persistent: true,
      partialResults: true,
      serverBoundaries: true,
      coverageCheckpoints: true,
      resumable: true,
      latencyModes: Object.freeze([...latencyModes]),
    }),
  });
}

/**
 * Strictly recognize the complete v1 streaming contract.
 *
 * Exact keys make the version meaningful: an endpoint with a renamed or newly
 * interpreted field must advertise another schema version rather than being
 * accidentally upgraded by a permissive alias reader.
 */
export function isStreamingTranscriptionCapabilities(
  advertised: unknown,
): advertised is MeetingStreamingTranscriptionCapabilities {
  return normalizeStreamingTranscriptionCapabilities(advertised) !== null;
}

/** Normalize one endpoint document; every non-v1-complete shape fails closed. */
export function describeTranscriptionEndpoint(advertised: unknown): MeetingTranscriptionCapabilities {
  return normalizeStreamingTranscriptionCapabilities(advertised) ?? SEGMENTED_TRANSCRIPTION_CAPABILITIES;
}

/** D10 strategy selection has no host input, so both hosts must reach the same answer. */
export function selectTranscriptionMode(endpoint: MeetingTranscriptionCapabilities): MeetingTranscriptionMode {
  return endpoint.streaming === null ? 'segmented' : 'streaming';
}

/** Only the complete streaming contract permits a live mid-utterance text promise. */
export function liveTextExpected(endpoint: MeetingTranscriptionCapabilities): boolean {
  return endpoint.streaming !== null;
}

/** The existing segmented upload path, one bounded unit per request. */
export interface MeetingSegmentedTranscription {
  readonly mode: 'segmented';
  transcribe(audio: Uint8Array, mimeType: string): Promise<string> | string;
}

export interface MeetingTranscriptionStreamInitialization {
  readonly mimeType: string;
  /** The persisted recording's container initialization segment; explicitly empty when the container has none. */
  readonly initializationSegment: Uint8Array;
}

export interface MeetingTranscriptionStreamChunk extends Pick<MeetingChunk, 'sequence' | 'startMs' | 'endMs'> {
  /** The exact bytes already persisted under `sequence`. */
  readonly audio: Uint8Array;
}

/** A connection that lasts for a meeting, or until its adapter reports a drop. */
export interface MeetingTranscriptionStream {
  /** Required once per connection before any chunk, including after reconnect. */
  initialize(input: MeetingTranscriptionStreamInitialization): Promise<void> | void;
  /** Send only a durability chunk whose bytes and timing ledger entry are already persisted locally. */
  send(chunk: MeetingTranscriptionStreamChunk): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface MeetingStreamHandlers {
  onEvent(event: MeetingStreamingTranscriptEvent): void;
  onDrop(error?: unknown): void;
}

export interface MeetingTranscriptionStreamOpenInput {
  readonly latencyMode: MeetingTranscriptionLatencyMode;
  /** The last atomically persisted token, or null — never an unpersisted reducer result or inferred timestamp. */
  readonly resumeFrom: MeetingTranscriptCommittedCheckpoint | null;
  readonly handlers: MeetingStreamHandlers;
}

/**
 * The streaming path is the segmented path plus a resumable connection. The
 * fallback method is mandatory because persisted chunks still need a drain path
 * when the live connection is unavailable.
 */
export interface MeetingStreamingTranscription extends Omit<MeetingSegmentedTranscription, 'mode'> {
  readonly mode: 'streaming';
  open(input: MeetingTranscriptionStreamOpenInput): Promise<MeetingTranscriptionStream> | MeetingTranscriptionStream;
}

export type MeetingTranscription = MeetingSegmentedTranscription | MeetingStreamingTranscription;

/**
 * A segmented endpoint keeps the ordinary upload target. A streaming endpoint
 * normally seals at the server boundary; this policy is only its bounded
 * fallback when no boundary arrives, and the chunk-ledger module remains the
 * sole owner of how that ceiling-only policy is derived.
 */
export function unitPolicyFor(
  mode: MeetingTranscriptionMode,
  policy: MeetingUnitPolicy = DEFAULT_MEETING_UNIT_POLICY,
): MeetingUnitPolicy {
  if (mode === 'segmented') return policy;
  return boundedEndpointUnitPolicy(policy);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(source);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string')
    && expected.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function isLatencyModeList(value: unknown): value is readonly MeetingTranscriptionLatencyMode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEETING_TRANSCRIPTION_LATENCY_MODES.length) {
    return false;
  }
  const modes = new Set<MeetingTranscriptionLatencyMode>();
  for (const entry of value) {
    if (!MEETING_TRANSCRIPTION_LATENCY_MODES.includes(entry as MeetingTranscriptionLatencyMode)) return false;
    modes.add(entry as MeetingTranscriptionLatencyMode);
  }
  return modes.size === value.length;
}

function normalizeStreamingTranscriptionCapabilities(
  advertised: unknown,
): MeetingStreamingTranscriptionCapabilities | null {
  try {
    if (!isRecord(advertised)
      || !hasExactKeys(advertised, ['schemaVersion', 'segmentedUpload', 'streaming'])) {
      return null;
    }
    const schemaVersion = advertised.schemaVersion;
    const segmentedUpload = advertised.segmentedUpload;
    const streaming = advertised.streaming;
    if (schemaVersion !== 1 || segmentedUpload !== true || !isRecord(streaming)) return null;
    if (!hasExactKeys(streaming, [
      'persistent',
      'partialResults',
      'serverBoundaries',
      'coverageCheckpoints',
      'resumable',
      'latencyModes',
    ])) {
      return null;
    }

    const persistent = streaming.persistent;
    const partialResults = streaming.partialResults;
    const serverBoundaries = streaming.serverBoundaries;
    const coverageCheckpoints = streaming.coverageCheckpoints;
    const resumable = streaming.resumable;
    const latencyModes = streaming.latencyModes;
    if (persistent !== true
      || partialResults !== true
      || serverBoundaries !== true
      || coverageCheckpoints !== true
      || resumable !== true
      || !isLatencyModeList(latencyModes)) {
      return null;
    }
    return createStreamingTranscriptionCapabilities(latencyModes);
  } catch {
    return null;
  }
}
