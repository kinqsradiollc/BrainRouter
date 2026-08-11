/**
 * ADR-035 D9 — the durability chunk and the transcription unit, and the rule
 * that turns the first into the second.
 *
 * ## What it owns
 *
 * The chunk ledger of a capture (what was written down, in what order, covering
 * what stretch of the meeting), the policy that decides how many chunks make a
 * unit, and the pure assembly that seals a run of chunks into one. Nothing else:
 * no status rules, no I/O, no clock. `captureSession.ts` wraps these with the
 * lifecycle checks and is what a host actually calls.
 *
 * ## Why it exists
 *
 * D3 said "the unit of transcription is a segment" and D1 said chunks are
 * written as they arrive, and the build quite reasonably made those one
 * 20-second constant. Using it showed that constant answering three questions
 * that have three different answers:
 *
 * - **how much may a crash cost?** — seconds. A short write cadence.
 * - **how much audio does the model need?** — an utterance. Longer, and shaped
 *   by speech rather than by a clock.
 * - **how fast should text appear?** — continuously, which no clock-shaped
 *   answer can give at all (D10).
 *
 * Shrinking the number would have made the second and third worse while barely
 * helping the first, which is why the ADR says the knob was the wrong knob. So
 * the two survivors separate here: a CHUNK is what `ondataavailable` delivered
 * and what was written durably, and a UNIT is assembled from chunks by whichever
 * transcription strategy is in play.
 *
 * ## The invariants
 *
 * 1. **A chunk is claimed by at most one unit, and units claim chunks
 *    front-to-back.** So "which chunks has no unit taken yet" is a suffix of the
 *    ledger, and sealing is always about that suffix. Anything else would let
 *    two units read the same audio and put the same words in the transcript
 *    twice.
 * 2. **A unit's range is its chunks' range.** `startMs` is the first chunk's
 *    start and `endMs` the last chunk's end, so D5's gap marker states one
 *    honest range no matter how many chunks went into it.
 * 3. **A record with no ledger is a record from before D9, and it is read, not
 *    rejected.** In those builds a unit WAS a chunk, filed under the unit's own
 *    index, so the ledger is derivable exactly. A stored session from the
 *    current build must not become unreadable, and a migration pass that had to
 *    run before the audio could be found again would be one more thing between a
 *    killed meeting and the person looking for it.
 * 4. **Nothing here validates a lifecycle.** Appending to a discarded meeting is
 *    refused in `captureSession.ts`, once, where every other transition is
 *    refused. Two places that both half-check a status is how one of them ends
 *    up not checking it.
 */
import type { MeetingCaptureSession, MeetingChunk, MeetingSegment } from './types.js';

/**
 * D9 — how much a crash may cost, and nothing else.
 *
 * The ADR's range is 2–5s and this is the middle of it. It is deliberately NOT
 * the transcription unit: a unit this short cuts sentences into pieces, which is
 * the §5.1 complaint the old shared constant answered by being twenty seconds
 * long and therefore twenty seconds expensive to lose.
 */
export const DEFAULT_MEETING_CHUNK_MS = 3_000;

/**
 * D9 — how much audio the segmented strategy sends at once.
 *
 * Same number the old conflated constant had, and that is the point: the batch
 * upload path did not want a different amount of audio, it wanted to stop being
 * the write cadence as well. The streaming strategy (D10) does not use this at
 * all — its boundaries come from the endpoint, and this file's ceilings are what
 * bound it.
 */
export const DEFAULT_MEETING_UNIT_MS = 20_000;

/**
 * How chunks become units.
 *
 * `targetMs` is what the strategy asks for. `maxMs` and `maxBytes` are ceilings
 * rather than preferences: they exist so that a strategy which decides its own
 * boundaries — a streaming endpoint that never says "utterance complete", or one
 * that has stopped answering — cannot leave the whole meeting sitting in an open
 * run with nothing durable claiming it. §6's "a meeting longer than the body
 * limit completes" is the byte ceiling's whole job.
 */
export interface MeetingUnitPolicy {
  readonly targetMs: number;
  readonly maxMs: number;
  readonly maxBytes: number;
}

/**
 * The segmented strategy's policy.
 *
 * `maxMs` is a little over twice the target so a unit can absorb an endpoint
 * that is slow to declare a boundary without ever growing unbounded; `maxBytes`
 * is a fifth of the sidecar's 40 MB body limit (`audioRoutes.ts`), which leaves
 * room for the container header a later unit carries in front of it.
 */
export const DEFAULT_MEETING_UNIT_POLICY: MeetingUnitPolicy = {
  targetMs: DEFAULT_MEETING_UNIT_MS,
  maxMs: 45_000,
  maxBytes: 8 * 1024 * 1024,
};

/**
 * An endpoint-selected boundary stays one unit unless a hard ceiling cuts it.
 *
 * Using `maxMs` as the target preserves the endpoint's linguistic boundary for
 * ordinary utterances while still making `maxMs`/`maxBytes` truthful ceilings.
 * Without this, omitting `policy` bypassed both and one delayed acknowledgement
 * could recreate the oversized request D3 removed.
 */
const BOUNDED_ENDPOINT_UNIT_POLICY: MeetingUnitPolicy = {
  ...DEFAULT_MEETING_UNIT_POLICY,
  targetMs: DEFAULT_MEETING_UNIT_POLICY.maxMs,
};

/**
 * Invariant 3 — the chunks one unit was assembled from.
 *
 * The `?? [segment.index]` is the whole backward-compatibility story: a record
 * written before D9 has no `chunks` because a unit was a chunk, filed under the
 * unit's index. Returning that is not a guess, it is what those builds meant.
 */
export function unitChunkSequences(segment: MeetingSegment): readonly number[] {
  return segment.chunks ?? [segment.index];
}

/**
 * The ledger, derived for a pre-D9 record.
 *
 * Deriving rather than migrating is deliberate (invariant 3): every read path
 * goes through here, so an old session is correct the moment it is loaded rather
 * than the moment somebody remembers to upgrade it. The field appears on the
 * record the first time a chunk is appended.
 */
export function captureChunks(session: MeetingCaptureSession): readonly MeetingChunk[] {
  if (session.chunks !== undefined) return session.chunks;
  return session.segments.map((segment) => ({
    sequence: segment.index,
    byteLength: segment.byteLength,
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));
}

/** Invariant 1 — how far into the ledger the units reach. */
export function claimedChunkCount(session: MeetingCaptureSession): number {
  let claimed = 0;
  for (const segment of session.segments) {
    for (const sequence of unitChunkSequences(segment)) {
      if (sequence + 1 > claimed) claimed = sequence + 1;
    }
  }
  return claimed;
}

/**
 * The chunks written down that no unit has claimed — the half-assembled unit a
 * kill interrupts, and the run a seal turns into one.
 */
export function openChunks(session: MeetingCaptureSession): readonly MeetingChunk[] {
  const claimed = claimedChunkCount(session);
  return captureChunks(session).filter((chunk) => chunk.sequence >= claimed);
}

/** The sequence the next written chunk gets. */
export function nextChunkSequence(session: MeetingCaptureSession): number {
  const chunks = captureChunks(session);
  const last = chunks[chunks.length - 1];
  return last ? last.sequence + 1 : 0;
}

/**
 * Bytes the host claims to hold for this capture, counted from the LEDGER.
 *
 * Counting units instead is the §6 regression D9 would otherwise introduce: a
 * recording killed before its first unit was sealed holds real audio and would
 * report zero, so the recovery offer would never mention it. For a pre-D9 record
 * the two counts are identical, because there the units were the ledger.
 */
export function capturedChunkByteLength(session: MeetingCaptureSession): number {
  return captureChunks(session).reduce((total, chunk) => total + chunk.byteLength, 0);
}

/** How far into the meeting the written audio reaches, units sealed or not. */
export function capturedElapsedMs(session: MeetingCaptureSession): number {
  const chunks = captureChunks(session);
  const last = chunks[chunks.length - 1];
  return last ? last.endMs : 0;
}

/** The span of the run a seal would claim right now. */
export function openChunkSpanMs(session: MeetingCaptureSession): number {
  const open = openChunks(session);
  if (!open.length) return 0;
  return open[open.length - 1]!.endMs - open[0]!.startMs;
}

/** The bytes a seal would claim right now — what one upload would carry. */
export function openChunkByteLength(session: MeetingCaptureSession): number {
  return openChunks(session).reduce((total, chunk) => total + chunk.byteLength, 0);
}

/**
 * Is the open run big enough to be a unit?
 *
 * Three ways to be due, and the last two are the ceilings rather than the ask:
 * the strategy's target, the hard duration bound, and the body-size bound. A
 * streaming endpoint that never declares a boundary hits the second or third and
 * the meeting still becomes text.
 */
export function shouldSealUnit(
  session: MeetingCaptureSession,
  policy: MeetingUnitPolicy = DEFAULT_MEETING_UNIT_POLICY,
): boolean {
  const open = openChunks(session);
  if (!open.length) return false;
  const spanMs = open[open.length - 1]!.endMs - open[0]!.startMs;
  if (spanMs >= policy.targetMs || spanMs >= policy.maxMs) return true;
  return open.reduce((total, chunk) => total + chunk.byteLength, 0) >= policy.maxBytes;
}

export interface AppendChunkInput {
  readonly byteLength: number;
  readonly durationMs: number;
  /** Elapsed-ms start. Defaults to the previous chunk's end — the recorder's own cadence. */
  readonly startMs?: number;
}

/**
 * D1/D9 — the host has written a chunk down; record it.
 *
 * Called AFTER the bytes land, never before: the ledger is the model's claim
 * that audio for that range exists on the device, and recovery believes it.
 */
export function appendChunkToLedger(
  session: MeetingCaptureSession,
  input: AppendChunkInput,
): MeetingCaptureSession {
  const byteLength = Math.round(input.byteLength);
  if (!Number.isFinite(input.byteLength) || byteLength <= 0) {
    throw new Error('A meeting chunk must carry at least one byte of audio.');
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    throw new Error('A meeting chunk must cover a positive duration.');
  }
  const chunks = captureChunks(session);
  const previousEnd = chunks.length ? chunks[chunks.length - 1]!.endMs : 0;
  const requestedStartMs = input.startMs ?? previousEnd;
  // Ranges are what a gap marker prints (D5) and what a unit's own range is
  // computed from; overlapping or reversed ones would make both unreadable.
  if (!Number.isFinite(requestedStartMs) || requestedStartMs < previousEnd) {
    throw new Error('A meeting chunk cannot start before the previous chunk ended.');
  }
  const startMs = Math.round(requestedStartMs);
  const endMs = Math.round(requestedStartMs + input.durationMs);
  if (endMs <= startMs) {
    throw new Error('A meeting chunk must cover a positive duration.');
  }
  const chunk: MeetingChunk = {
    sequence: nextChunkSequence(session),
    byteLength,
    startMs,
    endMs,
  };
  return { ...session, chunks: [...chunks, chunk] };
}

export interface SealUnitsInput {
  /**
   * Seal only as far as this chunk, inclusive — what a streaming endpoint's
   * acknowledgement means (D10). Chunks past it stay open.
   */
  readonly throughSequence?: number;
  /**
   * Cut the run into units of about this size instead of preserving the
   * endpoint-selected boundary. Omit to keep that boundary as one unit unless a
   * default hard duration/byte ceiling has to split it.
   */
  readonly policy?: MeetingUnitPolicy;
  /**
   * Leave a trailing part-unit open rather than sealing it — a live recorder
   * sealing what is due while the meeting continues. Ignored when
   * `throughSequence` is given, because that IS the boundary.
   */
  readonly keepRemainder?: boolean;
}

/**
 * Invariants 1 and 2 — turn the open run into units.
 *
 * Returns the session unchanged when there is nothing to seal, so a caller can
 * run it on every chunk without checking first.
 */
export function sealUnitsFromLedger(
  session: MeetingCaptureSession,
  input: SealUnitsInput = {},
): MeetingCaptureSession {
  let open = openChunks(session);
  if (input.throughSequence !== undefined) {
    const limit = input.throughSequence;
    open = open.filter((chunk) => chunk.sequence <= limit);
  }
  if (!open.length) return session;

  const policy = input.policy ?? BOUNDED_ENDPOINT_UNIT_POLICY;
  const runs = cutRuns(open, policy, Boolean(input.keepRemainder) && input.throughSequence === undefined);
  if (!runs.length) return session;

  const segments = session.segments.slice();
  for (const run of runs) {
    segments.push(toUnit(segments.length, run));
  }
  return { ...session, segments };
}

/**
 * The unit a run of chunks becomes.
 *
 * `state: 'pending'` always: sealing says "this much audio is one thing to
 * transcribe", never "and it has been". A streaming strategy settles the unit
 * with `markDone` in the same breath; the segmented queue picks it up as work.
 */
function toUnit(index: number, run: readonly MeetingChunk[]): MeetingSegment {
  return {
    index,
    byteLength: run.reduce((total, chunk) => total + chunk.byteLength, 0),
    startMs: run[0]!.startMs,
    endMs: run[run.length - 1]!.endMs,
    chunks: run.map((chunk) => chunk.sequence),
    state: 'pending',
    attempts: 0,
  };
}

/**
 * Cut a run into policy-sized units.
 *
 * A unit closes on the chunk that first takes it to `targetMs`, or earlier if
 * one more chunk would breach a ceiling. The remainder is either its own
 * (short) unit — a stop, a recovery, a drain of chunks nobody claimed — or left
 * open for the next chunk to join, which is what a live recorder wants.
 */
function cutRuns(
  open: readonly MeetingChunk[],
  policy: MeetingUnitPolicy,
  keepRemainder: boolean,
): MeetingChunk[][] {
  const runs: MeetingChunk[][] = [];
  let current: MeetingChunk[] = [];
  let bytes = 0;
  for (const chunk of open) {
    const spanWithChunk = current.length ? chunk.endMs - current[0]!.startMs : chunk.endMs - chunk.startMs;
    const bytesWithChunk = bytes + chunk.byteLength;
    // A single chunk that already breaches a ceiling still forms a unit of its
    // own: refusing it would strand audio that is on disk, and a unit smaller
    // than the ceiling is not available to us — the chunk is the grain.
    if (current.length && (bytesWithChunk > policy.maxBytes || spanWithChunk > policy.maxMs)) {
      runs.push(current);
      current = [chunk];
      bytes = chunk.byteLength;
    } else {
      current.push(chunk);
      bytes = bytesWithChunk;
    }
    const span = chunk.endMs - current[0]!.startMs;
    if (span >= policy.targetMs || bytes >= policy.maxBytes) {
      runs.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length && !keepRemainder) runs.push(current);
  return runs;
}
