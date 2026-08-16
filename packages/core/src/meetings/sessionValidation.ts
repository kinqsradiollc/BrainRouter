/**
 * ADR-035 D2/D9 — validate a persisted meeting session at the shared boundary.
 *
 * Hosts store the same session in different media, but corruption means the
 * same thing on both: a unit that points at the wrong durability chunk can turn
 * missing or duplicated audio into plausible transcript text. That relational
 * rule therefore belongs with the shared model, not in either JSON reader.
 *
 * Compatibility is deliberate. A pre-D9 session has no ledger and its units
 * have no chunk references because each unit was its own chunk. When such a
 * session first appends a D9 chunk, the derived legacy chunks become a ledger;
 * the old implicit units stay at the front and new explicit units follow. Both
 * shapes are accepted. A current ledger may also have an unclaimed suffix: it
 * is the durable, still-open unit left by ordinary recording or a process kill.
 */
import { isMeetingSessionId } from './captureSession.js';
import type {
  MeetingCaptureScope,
  MeetingCaptureSession,
  MeetingChunk,
  MeetingSegment,
} from './types.js';

const CAPTURE_STATUSES = new Set(['recording', 'stopped', 'finalized', 'discarded']);
const CAPTURE_TEMPLATES = new Set(['general', 'standup', 'one-on-one', 'retrospective']);
const SEGMENT_STATES = new Set(['pending', 'transcribing', 'done', 'failed']);

/**
 * Runtime type guard for a meeting session read from storage or another process.
 *
 * Besides the scalar shape, it proves the D9 relation:
 *
 * - ledger keys are `0..n-1`, ranges are ordered, and every chunk has bytes;
 * - units claim one ascending, gapless prefix of that ledger exactly once;
 * - each unit's bytes and range equal the chunks it names;
 * - the remaining ledger suffix, if any, is a valid open unit;
 * - pre-D9 implicit units and a migrated implicit prefix remain readable.
 *
 * It also proves the lifecycle word came from a real shared transition. A
 * recording has neither lifecycle timestamp, a stopped capture has only
 * `stoppedAt`, and a terminal capture has both `stoppedAt` and `closedAt`.
 * This is a safety boundary: hosts may delete audio for a terminal session, so
 * a torn or corrupted record whose only change is `status: 'discarded'` must
 * enter salvage instead of becoming authority to erase the physical chunks.
 */
export function isMeetingCaptureSession(value: unknown): value is MeetingCaptureSession {
  if (!isRecord(value)) return false;
  if (!isMeetingSessionId(value.id) || typeof value.startedAt !== 'string') return false;
  if (typeof value.title !== 'string' || !isNamedValue(value.template, CAPTURE_TEMPLATES)) return false;
  if (!isNamedValue(value.status, CAPTURE_STATUSES) || !isCaptureScope(value.scope)) return false;
  if (value.language !== undefined && typeof value.language !== 'string') return false;
  if (!hasLifecycleTimestamps(value.status, value.stoppedAt, value.closedAt)) return false;
  if (!Array.isArray(value.segments) || !value.segments.every(isStoredSegment)) return false;

  const segments = value.segments as readonly MeetingSegment[];
  if (value.chunks === undefined) {
    // A reference without a ledger has no storage key to resolve. In the
    // pre-D9 shape the unit index itself was the key, represented by absence.
    return segments.every((segment) => segment.chunks === undefined)
      && rangesAreOrdered(segments);
  }
  if (!isMeetingChunkLedger(value.chunks)) return false;

  const ledger = value.chunks as readonly MeetingChunk[];
  let nextSequence = 0;
  let sawExplicitUnit = false;
  for (const segment of segments) {
    const explicit = segment.chunks !== undefined;
    // Migration materializes the legacy ledger but does not rewrite its units,
    // so implicit units are valid only as the leading legacy prefix.
    if (!explicit && sawExplicitUnit) return false;
    if (explicit) sawExplicitUnit = true;

    const sequences = segment.chunks ?? [segment.index];
    if (sequences.some((sequence, offset) => sequence !== nextSequence + offset)) return false;
    const claimed = sequences.map((sequence) => ledger[sequence]);
    if (claimed.some((entry) => entry === undefined)) return false;
    const chunks = claimed as readonly MeetingChunk[];
    if (segment.byteLength !== chunks.reduce((total, chunk) => total + chunk.byteLength, 0)) return false;
    if (segment.startMs !== chunks[0]!.startMs || segment.endMs !== chunks[chunks.length - 1]!.endMs) return false;
    nextSequence += sequences.length;
  }

  // `nextSequence..ledger.length - 1` is allowed: bytes are durable before the
  // strategy seals them into the next transcription unit.
  return true;
}

function isStoredSegment(value: unknown, position: number): value is MeetingSegment {
  if (!isRecord(value) || value.index !== position) return false;
  if (!isPositiveFinite(value.byteLength)) return false;
  if (!isNonNegativeFinite(value.startMs) || !isPositiveFinite(value.endMs) || value.endMs <= value.startMs) {
    return false;
  }
  if (!Number.isInteger(value.attempts) || (value.attempts as number) < 0) return false;
  if (!isNamedValue(value.state, SEGMENT_STATES)) return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (value.failureReason !== undefined && typeof value.failureReason !== 'string') return false;
  if (value.lastAttemptAt !== undefined && typeof value.lastAttemptAt !== 'string') return false;
  if (value.deferrals !== undefined && (!Number.isInteger(value.deferrals) || (value.deferrals as number) < 0)) {
    return false;
  }
  if (value.chunks !== undefined) {
    if (!Array.isArray(value.chunks) || value.chunks.length === 0) return false;
    const sequences = value.chunks;
    if (sequences.some((sequence, offset) => (
      !Number.isInteger(sequence)
      || sequence < 0
      || (offset > 0 && sequence !== sequences[offset - 1]! + 1)
    ))) return false;
  }
  return true;
}

/** The one pure D9 ledger validator used by storage and streaming coverage. */
export function isMeetingChunkLedger(value: unknown): value is readonly MeetingChunk[] {
  try {
    if (!Array.isArray(value)) return false;
    let previousEnd = 0;
    return value.every((entry, position) => {
      if (!isRecord(entry) || entry.sequence !== position || !isPositiveSafeInteger(entry.byteLength)) return false;
      if (!isNonNegativeSafeInteger(entry.startMs)
        || !isPositiveSafeInteger(entry.endMs)
        || entry.endMs <= entry.startMs) {
        return false;
      }
      if (entry.startMs < previousEnd) return false;
      previousEnd = entry.endMs;
      return true;
    });
  } catch {
    return false;
  }
}

function rangesAreOrdered(segments: readonly MeetingSegment[]): boolean {
  let previousEnd = 0;
  for (const segment of segments) {
    if (segment.startMs < previousEnd) return false;
    previousEnd = segment.endMs;
  }
  return true;
}

function isCaptureScope(value: unknown): value is MeetingCaptureScope {
  if (!isRecord(value)) return false;
  if (value.orgId !== null && typeof value.orgId !== 'string') return false;
  return value.workspaceId === undefined || value.workspaceId === null || typeof value.workspaceId === 'string';
}

/** The exact timestamp presence written by captureSession's four lifecycle states. */
function hasLifecycleTimestamps(status: string, stoppedAt: unknown, closedAt: unknown): boolean {
  if (status === 'recording') return stoppedAt === undefined && closedAt === undefined;
  if (status === 'stopped') return isPersistedTimestamp(stoppedAt) && closedAt === undefined;
  return isPersistedTimestamp(stoppedAt) && isPersistedTimestamp(closedAt);
}

/** Transitions persist ISO instants; accepting arbitrary text would make field presence a forgeable token. */
function isPersistedTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNamedValue(value: unknown, names: ReadonlySet<string>): value is string {
  return typeof value === 'string' && names.has(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
