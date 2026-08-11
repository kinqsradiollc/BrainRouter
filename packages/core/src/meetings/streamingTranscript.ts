/**
 * ADR-035 D10 — pure live-utterance reduction and durable coverage proof.
 *
 * This is an ephemeral live-display buffer, not the meeting draft and not the
 * settled compose box. A host may append a newly final utterance through the
 * existing transcript fold, but it never hands editable text to this reducer.
 * That boundary makes a late revision structurally unable to overwrite words a
 * person has edited.
 *
 * Upstream finality and host durability are separate facts. `partial` and
 * `final` events contain only utterance text. A `coverage` event says every
 * sample through a durability-chunk sequence is represented by earlier finals
 * or silence and will not be revised. Only valid coverage over the ordered D9
 * ledger may advance the transcript-committed checkpoint.
 *
 * The returned checkpoint becomes reconnect authority only after the host
 * persists the returned transcript state and checkpoint in one atomic
 * transition. This reducer never mutates its input, so failed persistence must
 * keep using the prior persisted state and its prior checkpoint.
 */
import { isMeetingChunkLedger } from './sessionValidation.js';
import type { MeetingChunk } from './types.js';

interface MeetingUtteranceEventBase {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A provisional revision. It deliberately has no coverage field. */
export interface MeetingTranscriptionPartialEvent extends MeetingUtteranceEventBase {
  readonly kind: 'partial';
}

/** Upstream final text. Finality does not acknowledge or cover audio chunks. */
export interface MeetingTranscriptionFinalEvent extends MeetingUtteranceEventBase {
  readonly kind: 'final';
}

/**
 * Every sample through this D9 chunk is represented by earlier finals or
 * silence and will not be revised by the upstream transcription session.
 */
export interface MeetingTranscriptionCoverageEvent {
  readonly kind: 'coverage';
  readonly coveredThroughSequence: number;
}

export type MeetingStreamingTranscriptEvent =
  | MeetingTranscriptionPartialEvent
  | MeetingTranscriptionFinalEvent
  | MeetingTranscriptionCoverageEvent;

interface MeetingLiveUtteranceBase extends MeetingUtteranceEventBase {
  readonly state: 'partial' | 'final';
}

export interface MeetingLivePartialUtterance extends MeetingLiveUtteranceBase {
  readonly kind: 'partial';
  readonly state: 'partial';
}

export interface MeetingFinalUtterance extends MeetingLiveUtteranceBase {
  readonly kind: 'final';
  readonly state: 'final';
}

export type MeetingLiveUtterance = MeetingLivePartialUtterance | MeetingFinalUtterance;

/** The host-persisted reconnect token produced from a valid coverage event. */
export interface MeetingTranscriptCommittedCheckpoint {
  readonly kind: 'transcript-committed';
  /** The coverage sequence whose transcript state the host persisted with this token. */
  readonly acknowledgedThroughSequence: number;
}

export interface MeetingStreamingTranscriptState {
  readonly utterances: readonly MeetingLiveUtterance[];
  readonly checkpoint: MeetingTranscriptCommittedCheckpoint | null;
}

export const EMPTY_STREAMING_TRANSCRIPT: MeetingStreamingTranscriptState = Object.freeze({
  utterances: Object.freeze([]) as readonly MeetingLiveUtterance[],
  checkpoint: null,
});

/**
 * Prove that new coverage advances across an unbroken persisted chunk prefix.
 * Duplicate/backwards coverage returns `null`; it creates no new resume token.
 */
export function validateTranscriptCommittedCheckpoint(
  previousAcknowledgedThroughSequence: number | null,
  acknowledgedThroughSequence: number,
  persistedLedger: readonly MeetingChunk[],
): MeetingTranscriptCommittedCheckpoint | null {
  const existing = previousAcknowledgedThroughSequence === null
    ? null
    : { kind: 'transcript-committed', acknowledgedThroughSequence: previousAcknowledgedThroughSequence };
  const resolution = resolveTranscriptCommittedCheckpoint(existing, acknowledgedThroughSequence, persistedLedger);
  return resolution.status === 'advanced' ? resolution.checkpoint : null;
}

/**
 * Reduce one exact wire event without mutating settled/editable text.
 *
 * Revisions replace the live entry with the same `utteranceId`. Once final,
 * that entry is immutable. Coverage never changes utterances; it returns a new
 * checkpointed state for the host to persist atomically.
 */
export function reduceStreamingTranscript(
  state: MeetingStreamingTranscriptState,
  candidate: unknown,
  persistedLedger: readonly MeetingChunk[],
): MeetingStreamingTranscriptState {
  const restored = normalizeStreamingTranscriptState(state);
  if (!restored) return state;
  const event = normalizeStreamingTranscriptEvent(candidate);
  if (!event) return restored;

  if (event.kind === 'coverage') {
    const resolution = resolveTranscriptCommittedCheckpoint(
      restored.checkpoint,
      event.coveredThroughSequence,
      persistedLedger,
    );
    if (resolution.status !== 'advanced') return restored;
    const coveredEndMs = persistedLedger[event.coveredThroughSequence]?.endMs;
    if (!isElapsedTime(coveredEndMs)
      || restored.utterances.some((utterance) => utterance.state === 'partial' && utterance.startMs < coveredEndMs)) {
      return restored;
    }
    return freezeState(restored.utterances, resolution.checkpoint);
  }

  if (restored.checkpoint !== null) {
    const coveredEndMs = persistedCheckpointEndMs(restored.checkpoint, persistedLedger);
    if (coveredEndMs === null || event.startMs < coveredEndMs) return restored;
  }

  const index = restored.utterances.findIndex((utterance) => utterance.utteranceId === event.utteranceId);
  const current = index < 0 ? undefined : restored.utterances[index];
  if (current?.state === 'final' || (current && event.revision < current.revision)) return restored;
  // Finality may carry the last partial's revision because it is a lifecycle
  // transition, not necessarily another textual revision. Equality remains a
  // duplicate for partial→partial and is allowed only for partial→final.
  if (current && event.revision === current.revision && event.kind === 'partial') return restored;

  if (event.kind === 'partial') {
    return replaceUtterance(restored, index, Object.freeze({
      kind: 'partial',
      utteranceId: event.utteranceId,
      revision: event.revision,
      text: event.text,
      startMs: event.startMs,
      endMs: event.endMs,
      state: 'partial',
    }));
  }

  return replaceUtterance(restored, index, Object.freeze({
    kind: 'final',
    utteranceId: event.utteranceId,
    revision: event.revision,
    text: event.text,
    startMs: event.startMs,
    endMs: event.endMs,
    state: 'final',
  }));
}

function replaceUtterance(
  state: MeetingStreamingTranscriptState,
  index: number,
  utterance: MeetingLiveUtterance,
): MeetingStreamingTranscriptState {
  const utterances = state.utterances.slice();
  if (index < 0) utterances.push(utterance);
  else utterances[index] = utterance;
  return freezeState(utterances, state.checkpoint);
}

function freezeState(
  utterances: readonly MeetingLiveUtterance[],
  checkpoint: MeetingTranscriptCommittedCheckpoint | null,
): MeetingStreamingTranscriptState {
  return Object.freeze({
    utterances: Object.freeze([...utterances]),
    checkpoint,
  });
}

function normalizeStreamingTranscriptState(value: unknown): MeetingStreamingTranscriptState | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ['utterances', 'checkpoint'])) return null;
    const storedUtterances = value.utterances;
    const storedCheckpoint = value.checkpoint;
    if (!Array.isArray(storedUtterances)) return null;

    const utterances: MeetingLiveUtterance[] = [];
    const ids = new Set<string>();
    for (const stored of storedUtterances) {
      const utterance = normalizeLiveUtterance(stored);
      if (!utterance || ids.has(utterance.utteranceId)) return null;
      ids.add(utterance.utteranceId);
      utterances.push(utterance);
    }
    const checkpoint = storedCheckpoint === null
      ? null
      : normalizeTranscriptCommittedCheckpoint(storedCheckpoint);
    if (storedCheckpoint !== null && !checkpoint) return null;

    const alreadyCanonical = hasFrozenDataProperties(value, ['utterances', 'checkpoint'])
      && Object.isFrozen(storedUtterances)
      && storedUtterances.every((utterance) => hasFrozenDataProperties(
        utterance,
        ['kind', 'utteranceId', 'revision', 'text', 'startMs', 'endMs', 'state'],
      ))
      && (storedCheckpoint === null || hasFrozenDataProperties(
        storedCheckpoint,
        ['kind', 'acknowledgedThroughSequence'],
      ));
    return alreadyCanonical
      ? value as unknown as MeetingStreamingTranscriptState
      : freezeState(utterances, checkpoint);
  } catch {
    return null;
  }
}

function normalizeLiveUtterance(value: unknown): MeetingLiveUtterance | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['kind', 'utteranceId', 'revision', 'text', 'startMs', 'endMs', 'state'])) {
    return null;
  }
  const kind = value.kind;
  const state = value.state;
  const utteranceId = value.utteranceId;
  const revision = value.revision;
  const text = value.text;
  const startMs = value.startMs;
  const endMs = value.endMs;
  if ((kind !== 'partial' && kind !== 'final')
    || state !== kind
    || typeof utteranceId !== 'string'
    || utteranceId.trim().length === 0
    || !isSequence(revision)
    || typeof text !== 'string'
    || !isElapsedTime(startMs)
    || !isElapsedTime(endMs)
    || endMs <= startMs) {
    return null;
  }
  return kind === 'partial'
    ? Object.freeze({ kind, utteranceId, revision, text, startMs, endMs, state: 'partial' })
    : Object.freeze({ kind, utteranceId, revision, text, startMs, endMs, state: 'final' });
}

interface AdvancedTranscriptCheckpoint {
  readonly status: 'advanced';
  readonly checkpoint: MeetingTranscriptCommittedCheckpoint;
}

interface UnchangedTranscriptCheckpoint {
  readonly status: 'same' | 'invalid';
}

type TranscriptCheckpointResolution = AdvancedTranscriptCheckpoint | UnchangedTranscriptCheckpoint;

const INVALID_TRANSCRIPT_CHECKPOINT: UnchangedTranscriptCheckpoint = Object.freeze({ status: 'invalid' });
const SAME_TRANSCRIPT_CHECKPOINT: UnchangedTranscriptCheckpoint = Object.freeze({ status: 'same' });

function resolveTranscriptCommittedCheckpoint(
  existingValue: unknown,
  coveredThroughSequence: number,
  persistedLedger: readonly MeetingChunk[],
): TranscriptCheckpointResolution {
  const existing = normalizeTranscriptCommittedCheckpoint(existingValue);
  if (existingValue !== null && !existing) return INVALID_TRANSCRIPT_CHECKPOINT;
  if (!isSequence(coveredThroughSequence)) return INVALID_TRANSCRIPT_CHECKPOINT;

  const previous = existing?.acknowledgedThroughSequence ?? -1;
  if (coveredThroughSequence < previous
    || !hasContiguousLedgerPrefix(persistedLedger, coveredThroughSequence)) {
    return INVALID_TRANSCRIPT_CHECKPOINT;
  }
  if (coveredThroughSequence === previous) return SAME_TRANSCRIPT_CHECKPOINT;
  return {
    status: 'advanced',
    checkpoint: Object.freeze({
      kind: 'transcript-committed',
      acknowledgedThroughSequence: coveredThroughSequence,
    }),
  };
}

function normalizeTranscriptCommittedCheckpoint(value: unknown): MeetingTranscriptCommittedCheckpoint | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ['kind', 'acknowledgedThroughSequence'])) return null;
    const kind = value.kind;
    const acknowledgedThroughSequence = value.acknowledgedThroughSequence;
    if (kind !== 'transcript-committed' || !isSequence(acknowledgedThroughSequence)) return null;
    return Object.freeze({ kind, acknowledgedThroughSequence });
  } catch {
    return null;
  }
}

function persistedCheckpointEndMs(
  checkpoint: unknown,
  persistedLedger: readonly MeetingChunk[],
): number | null {
  const normalized = normalizeTranscriptCommittedCheckpoint(checkpoint);
  if (!normalized
    || !hasContiguousLedgerPrefix(persistedLedger, normalized.acknowledgedThroughSequence)) {
    return null;
  }
  const endMs = persistedLedger[normalized.acknowledgedThroughSequence]?.endMs;
  return isElapsedTime(endMs) ? endMs : null;
}

function hasContiguousLedgerPrefix(persistedLedger: readonly MeetingChunk[], throughSequence: number): boolean {
  return isMeetingChunkLedger(persistedLedger) && throughSequence < persistedLedger.length;
}

function normalizeStreamingTranscriptEvent(value: unknown): MeetingStreamingTranscriptEvent | null {
  try {
    if (!isRecord(value)) return null;
    const kind = value.kind;
    if (kind === 'coverage') {
      if (!hasExactKeys(value, ['kind', 'coveredThroughSequence'])) return null;
      const coveredThroughSequence = value.coveredThroughSequence;
      return isSequence(coveredThroughSequence) ? { kind: 'coverage', coveredThroughSequence } : null;
    }

    const expectedKeys = kind === 'partial' || kind === 'final'
      ? ['kind', 'utteranceId', 'revision', 'text', 'startMs', 'endMs']
      : null;
    if (!expectedKeys || !hasExactKeys(value, expectedKeys)) return null;

    const utteranceId = value.utteranceId;
    const revision = value.revision;
    const text = value.text;
    const startMs = value.startMs;
    const endMs = value.endMs;
    if (typeof utteranceId !== 'string'
      || utteranceId.trim().length === 0
      || !isSequence(revision)
      || typeof text !== 'string'
      || !isElapsedTime(startMs)
      || !isElapsedTime(endMs)
      || endMs <= startMs) {
      return null;
    }

    return kind === 'partial'
      ? { kind: 'partial', utteranceId, revision, text, startMs, endMs }
      : { kind: 'final', utteranceId, revision, text, startMs, endMs };
  } catch {
    return null;
  }
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

function hasFrozenDataProperties(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value) || !Object.isFrozen(value)) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  });
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isElapsedTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
