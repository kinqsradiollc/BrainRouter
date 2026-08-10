/**
 * ADR-035 D1/D2 — believing the chunks: turning stored audio a session does not
 * mention into segments it does.
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
 * The invariants, because "adopt any leftover chunk" is too generous:
 *
 * 1. **A segment's index IS the chunk the queue reads audio from.** So adoption
 *    is contiguous from the end of the record and stops at the first missing
 *    sequence. Bridging a hole would transcribe segment N from segment N+1's
 *    audio — text that looks right and is wrong, which is worse than an
 *    unclaimed chunk.
 * 2. **Non-empty only.** A store can create a chunk and the process die before
 *    the write; the shared model refuses a zero-byte segment anyway.
 * 3. **A terminal session adopts nothing.** Under D6 a finalized or discarded
 *    meeting has had its audio released, so anything still stored for it is an
 *    orphan for the reap — and `rejected` is empty there, because deleting a
 *    terminal meeting's chunks is the reap's decision, not this rule's.
 *
 * `rejected` exists so the caller that owns bytes can act on them: the desktop
 * deletes the files past the hole (they can never be read in the right order
 * again), while the dashboard leaves them for its own reap. What may be
 * BELIEVED is one rule; what is done with the rest is host policy.
 *
 * Durations are the caller's nominal segment length, not a measured elapsed
 * time: the measurement died with the process that was making it, and a gap
 * marker (D5) needs a range that is monotonic and about right, not one invented
 * to look precise.
 */
import {
  appendSegment,
  DEFAULT_MEETING_SEGMENT_MS,
  isTerminalCaptureStatus,
  resumeCapture,
  stopCapture,
} from './captureSession.js';
import type { MeetingCaptureSession } from './types.js';

/**
 * What a host's store can say about one stored chunk without reading it.
 *
 * `sequence` is the key the store filed it under, which is the index the queue
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
  /** Sequences that became segments, ascending. */
  readonly adopted: readonly number[];
  /**
   * Sequences the session does not describe and this rule will not believe —
   * past a hole, or empty. The caller decides what to do with their bytes.
   */
  readonly rejected: readonly number[];
}

export interface AdoptCaptureChunksOptions {
  /** Duration credited to a chunk nothing described. Defaults to the shared segment length. */
  readonly segmentMs?: number;
}

export function adoptCaptureChunks(
  session: MeetingCaptureSession,
  chunks: readonly MeetingStoredChunk[],
  options: AdoptCaptureChunksOptions = {},
): MeetingChunkAdoption {
  if (isTerminalCaptureStatus(session.status)) return { session, adopted: [], rejected: [] };

  const unclaimed = new Map<number, number>();
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.sequence) || chunk.sequence < session.segments.length) continue;
    // A store keys chunks by sequence, so a duplicate is a caller confusion
    // rather than a real second chunk; the first reading wins over a later one.
    if (!unclaimed.has(chunk.sequence)) unclaimed.set(chunk.sequence, chunk.byteLength);
  }

  const believable: number[] = [];
  for (let index = session.segments.length; unclaimed.has(index); index += 1) {
    const byteLength = unclaimed.get(index)!;
    if (!Number.isFinite(byteLength) || byteLength <= 0) break;
    believable.push(index);
  }
  const adopted = new Set(believable);
  const rejected = [...unclaimed.keys()].filter((sequence) => !adopted.has(sequence)).sort(ascending);
  if (!believable.length) return { session, adopted: [], rejected };

  // `appendSegment` only accepts a recording session, so a cleanly stopped one is
  // resumed for the append and stopped again with its ORIGINAL timestamp — the
  // recording did not restart, and rewriting `stoppedAt` would misreport when it
  // ended.
  const stoppedAt = session.status === 'stopped' ? session.stoppedAt : undefined;
  const segmentMs = options.segmentMs ?? DEFAULT_MEETING_SEGMENT_MS;
  let next = session.status === 'recording' ? session : resumeCapture(session);
  for (const index of believable) {
    next = appendSegment(next, { byteLength: unclaimed.get(index)!, durationMs: segmentMs });
  }
  return {
    session: session.status === 'recording' ? next : stopCapture(next, stoppedAt),
    adopted: believable,
    rejected,
  };
}

function ascending(left: number, right: number): number {
  return left - right;
}
