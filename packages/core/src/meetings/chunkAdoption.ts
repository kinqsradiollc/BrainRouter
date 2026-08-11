/**
 * ADR-035 D1/D2/D9 — believing the chunks: turning stored audio a session does
 * not mention into audio it does.
 *
 * D1 writes the bytes and THEN the record, so the last thing a kill can
 * interrupt is the record — leaving audio on disk (or in OPFS) that the session
 * never claimed. Read the record alone and that audio is invisible for ever: it
 * holds quota, it is in no transcript, and nothing will ever offer it back. §6
 * asks for "the audio up to the kill", so the record is extended to claim what
 * the store actually holds rather than the audio being discarded to match a
 * stale record.
 *
 * This module owns that rule, once. Both hosts had reached it independently and
 * written it down twice — `adoptChunks` in the dashboard and
 * `adoptUnclaimedChunks` on the desktop, with verbatim-parallel comments
 * admitting they were "behaviourally aligned today; nothing keeps them so". The
 * rule is pure, so nothing kept them aligned except attention, and attention is
 * not a mechanism.
 *
 * ## What D9 changed here
 *
 * Adoption used to answer in UNITS, because a unit was a chunk: it appended one
 * segment per believed chunk and the segment's index was the key its audio was
 * read back by. Now a chunk is a durability decision two to five seconds wide,
 * so adopting one unit per chunk would produce a meeting made of three-second
 * uploads — the "shrinking the segment" non-fix D9 explicitly rejects, arrived
 * at by accident. So adoption believes chunks INTO THE LEDGER and then seals
 * them into units by the ordinary policy, exactly as the recorder would have.
 *
 * The invariants, because "adopt any leftover chunk" is too generous:
 *
 * 1. **A chunk's sequence is how its bytes are found.** So adoption is
 *    contiguous from the end of the ledger and stops at the first missing
 *    sequence. Bridging a hole would put chunk N+1's audio where chunk N's
 *    should be — text that looks right and is wrong, which is worse than an
 *    unclaimed chunk.
 * 2. **Non-empty only.** A store can create a chunk and the process die before
 *    the write; the shared model refuses a zero-byte chunk anyway.
 * 3. **A terminal session adopts nothing.** Under D6 a finalized or discarded
 *    meeting has had its audio released, so anything still stored for it is an
 *    orphan for the reap — and `rejected` is empty there, because deleting a
 *    terminal meeting's chunks is the reap's decision, not this rule's.
 *
 * `rejected` exists so the caller that owns bytes can account for them without
 * claiming them. A hole means later chunks cannot be placed on the timeline
 * today; it is not proof that those bytes are disposable, so both hosts preserve
 * them for a later repair or an explicit retention decision. What may be
 * BELIEVED is one rule; how unclaimed bytes are surfaced remains host policy.
 *
 * Durations are the caller's nominal CHUNK length, not a measured elapsed time:
 * the measurement died with the process that was making it, and a gap marker
 * (D5) needs a range that is monotonic and about right, not one invented to look
 * precise.
 */
import {
  appendChunk,
  isTerminalCaptureStatus,
  resumeCapture,
  sealUnit,
  stopCapture,
} from './captureSession.js';
import {
  captureChunks,
  DEFAULT_MEETING_CHUNK_MS,
  DEFAULT_MEETING_UNIT_MS,
  DEFAULT_MEETING_UNIT_POLICY,
  type MeetingUnitPolicy,
} from './chunkLedger.js';
import type { MeetingCaptureSession } from './types.js';

/**
 * What a host's store can say about one stored chunk without reading it.
 *
 * `sequence` is the key the store filed it under, which is the key the queue
 * will read it back by; `byteLength` is what is actually there, never what a
 * writer intended to put there.
 */
export interface MeetingStoredChunk {
  readonly sequence: number;
  readonly byteLength: number;
}

export interface MeetingChunkAdoption {
  /** The session extended by the believable chunks; unchanged when there are none. */
  readonly session: MeetingCaptureSession;
  /** Sequences that entered the ledger, ascending. */
  readonly adopted: readonly number[];
  /**
   * Sequences the session does not describe and this rule will not believe —
   * past a hole, or empty. The caller decides what to do with their bytes.
   */
  readonly rejected: readonly number[];
}

export interface AdoptCaptureChunksOptions {
  /**
   * Duration credited to a chunk nothing described. A D9 record defaults to the
   * shared durability cadence; a legacy record with no ledger defaults to the
   * old one-segment/one-chunk cadence so an upgrade does not shrink its range.
   */
  readonly chunkMs?: number;
  /**
   * @deprecated The old name from when a chunk and a unit were the same thing.
   * Still read, and still meaning the duration of ONE STORED CHUNK, so a host
   * that has not split its recorder keeps crediting the duration it actually
   * recorded with.
   */
  readonly segmentMs?: number;
  /** How the adopted chunks are cut into units. Defaults to the segmented strategy's. */
  readonly unitPolicy?: MeetingUnitPolicy;
}

export function adoptCaptureChunks(
  session: MeetingCaptureSession,
  chunks: readonly MeetingStoredChunk[],
  options: AdoptCaptureChunksOptions = {},
): MeetingChunkAdoption {
  if (isTerminalCaptureStatus(session.status)) return { session, adopted: [], rejected: [] };

  const known = captureChunks(session).length;
  const unclaimed = new Map<number, number>();
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.sequence) || chunk.sequence < known) continue;
    // A store keys chunks by sequence, so a duplicate is a caller confusion
    // rather than a real second chunk; the first reading wins over a later one.
    if (!unclaimed.has(chunk.sequence)) unclaimed.set(chunk.sequence, chunk.byteLength);
  }

  const believable: number[] = [];
  for (let sequence = known; unclaimed.has(sequence); sequence += 1) {
    const byteLength = unclaimed.get(sequence)!;
    if (!Number.isFinite(byteLength) || byteLength <= 0) break;
    believable.push(sequence);
  }
  const adopted = new Set(believable);
  const rejected = [...unclaimed.keys()].filter((sequence) => !adopted.has(sequence)).sort(ascending);
  if (!believable.length) return { session, adopted: [], rejected };

  // `appendChunk` only accepts a recording session, so a cleanly stopped one is
  // resumed for the append and stopped again with its ORIGINAL timestamp — the
  // recording did not restart, and rewriting `stoppedAt` would misreport when it
  // ended.
  const stoppedAt = session.status === 'stopped' ? session.stoppedAt : undefined;
  const storedChunkMs = session.chunks === undefined ? DEFAULT_MEETING_UNIT_MS : DEFAULT_MEETING_CHUNK_MS;
  const chunkMs = options.chunkMs ?? options.segmentMs ?? storedChunkMs;
  const unitPolicy = options.unitPolicy ?? DEFAULT_MEETING_UNIT_POLICY;
  let next = session.status === 'recording' ? session : resumeCapture(session);
  for (const sequence of believable) {
    next = appendChunk(next, { byteLength: unclaimed.get(sequence)!, durationMs: chunkMs });
  }
  // Seal the whole open run, including the trailing part-unit. The recording
  // that was going to extend it is over — this rule only ever runs over a record
  // some other process left behind — so a remainder left open would be audio the
  // ledger holds and no queue will ever read.
  next = sealUnit(next, { policy: unitPolicy });
  return {
    session: session.status === 'recording' ? next : stopCapture(next, stoppedAt),
    adopted: believable,
    rejected,
  };
}

function ascending(left: number, right: number): number {
  return left - right;
}
