/**
 * ADR-035 D3/D5/D7 — what the transcription queue should do next, as a pure
 * function of the persisted session.
 *
 * This module owns ONE question: given a meeting record, which segments should
 * be attempted right now, which are backing off, which have spent their budget,
 * and which are finished. It owns no I/O and no timers, which is what makes the
 * answer identical on both hosts and reproducible in a test at an exact instant.
 *
 * Two invariants, both of which the queue depends on:
 *
 * 1. **The retry rule is not restated here.** Whether a failed segment is due,
 *    waiting or spent comes from `retryDecision` in `retryPolicy.ts`, including
 *    the budget check applied to `pending` segments. A second backoff rule
 *    beside that one would drift, and the drift would show up as two hosts
 *    disagreeing about when a meeting is finally out of retries.
 * 2. **Every segment gets a disposition, always.** `slots.length` equals
 *    `session.segments.length`. D5's whole point is that a segment cannot fall
 *    out of the record by being forgotten, and a planner that silently omitted a
 *    segment would be the mechanism by which it did.
 *
 * The plan deliberately says nothing about endpoint availability: an outage
 * (D7) is a fact about the server, not about the meeting, so it is not in the
 * session and is not derivable from it. The queue tracks that separately.
 */
import { isTerminalCaptureStatus } from './captureSession.js';
import { retryDecision, type MeetingRetryOptions } from './retryPolicy.js';
import type { MeetingCaptureSession, MeetingSegment } from './types.js';

/**
 * What the queue would do with one segment.
 *
 * `exhausted` is the load-bearing one: it is D5's stated gap — the segment stays
 * in the transcript with its time range and stops being retried automatically,
 * until a person asks for it again.
 */
export type MeetingQueueDisposition = 'ready' | 'waiting' | 'in-flight' | 'exhausted' | 'settled';

export interface MeetingQueueSlot {
  readonly index: number;
  readonly disposition: MeetingQueueDisposition;
  /** Milliseconds until this segment becomes due; 0 unless `waiting`. */
  readonly waitMs: number;
  readonly attempts: number;
}

/**
 * `working` — there is something to dispatch or something in flight;
 * `waiting` — nothing is due yet but something becomes due at `nextWakeMs`;
 * `idle` — every segment has settled or spent its budget, so nothing will change
 * without a person asking; `closed` — the meeting is finalized or discarded and
 * under D6 its audio is gone.
 */
export type MeetingQueuePhase = 'working' | 'waiting' | 'idle' | 'closed';

export interface MeetingQueuePlan {
  readonly phase: MeetingQueuePhase;
  /** One entry per segment, in capture order. Never filtered. */
  readonly slots: readonly MeetingQueueSlot[];
  /** Indices to attempt now, earliest first — a meeting is read front to back. */
  readonly ready: readonly number[];
  readonly waiting: readonly number[];
  readonly inFlight: readonly number[];
  readonly exhausted: readonly number[];
  readonly settled: readonly number[];
  /** When the plan changes on its own, or `null` if only an external event can change it. */
  readonly nextWakeMs: number | null;
}

/**
 * The plan for a session at an instant.
 *
 * `options.nowMs` is passed explicitly by the queue (from its injected clock) and
 * by tests; defaulting to `Date.now()` is a convenience for a surface that only
 * wants to render the current picture.
 */
export function planTranscription(
  session: MeetingCaptureSession,
  options: MeetingRetryOptions = {},
): MeetingQueuePlan {
  const terminal = isTerminalCaptureStatus(session.status);
  const slots = session.segments.map((segment) => toSlot(segment, terminal, options));
  const ready = indicesOf(slots, 'ready');
  const waiting = indicesOf(slots, 'waiting');
  const inFlight = indicesOf(slots, 'in-flight');
  const waits = slots.filter((slot) => slot.disposition === 'waiting').map((slot) => slot.waitMs);
  return {
    phase: terminal
      ? 'closed'
      : ready.length || inFlight.length
        ? 'working'
        : waiting.length
          ? 'waiting'
          : 'idle',
    slots,
    ready,
    waiting,
    inFlight,
    exhausted: indicesOf(slots, 'exhausted'),
    settled: indicesOf(slots, 'settled'),
    nextWakeMs: waits.length ? Math.min(...waits) : null,
  };
}

/**
 * The floor on how soon a host may drain again, and the reason it lives beside
 * the schedule rather than in each host's timer.
 *
 * It was two constants over the same `nextWakeMs`: 250 ms on the desktop and an
 * inline `Math.max(500, …)` in the dashboard. Both exist for one reason — the
 * queue can legitimately answer `0`, which is what it says when it stopped with
 * work still ready because a write failed and blocked a segment. Honouring a
 * zero literally spins a host against a store that is already refusing it.
 *
 * So the floor only ever BINDS on that error path: every real backoff this
 * schedule produces starts at `baseDelayMs` (2 s), far above either constant.
 * Sized for the path it actually serves, the larger of the two is the right one
 * — two attempts a second at a failing disk instead of four — and the cost is at
 * most half a second of lateness on a backoff that was about to elapse anyway.
 *
 * It is a SCHEDULING floor, not a retry rule: what is due, and when, remains
 * entirely `retryPolicy.ts`'s answer.
 */
export const MEETING_MIN_WAKE_MS = 500;

/**
 * How long a host should actually wait before draining again.
 *
 * `null` in means `null` out — only new work will change anything, so there is
 * nothing to schedule. A non-finite delay is treated as the floor rather than
 * passed to a timer that would interpret it as "immediately".
 */
export function drainWakeDelayMs(nextWakeMs: number | null): number | null {
  if (nextWakeMs === null) return null;
  if (!Number.isFinite(nextWakeMs)) return MEETING_MIN_WAKE_MS;
  return Math.max(MEETING_MIN_WAKE_MS, Math.round(nextWakeMs));
}

function toSlot(
  segment: MeetingSegment,
  terminal: boolean,
  options: MeetingRetryOptions,
): MeetingQueueSlot {
  const base = { index: segment.index, attempts: segment.attempts };
  if (segment.state === 'done') return { ...base, disposition: 'settled', waitMs: 0 };
  // D6 — a finalized or discarded meeting has had its audio deleted, so anything
  // still untranscribed is a permanent gap rather than pending work. Reporting it
  // as `ready` would send the host to read a file that no longer exists.
  if (terminal) return { ...base, disposition: 'exhausted', waitMs: 0 };
  if (segment.state === 'transcribing') return { ...base, disposition: 'in-flight', waitMs: 0 };
  const decision = retryDecision(segment, options);
  if (segment.state === 'pending') {
    // A pending segment has no backoff to serve — nothing has failed on it. It
    // can still be out of budget: D7's give-back returns an outage attempt but
    // never the genuine failures underneath it, and a segment whose budget is
    // spent must not become fresh work again just because it is queued.
    return { ...base, disposition: decision.remainingAttempts > 0 ? 'ready' : 'exhausted', waitMs: 0 };
  }
  if (decision.verdict === 'waiting') return { ...base, disposition: 'waiting', waitMs: decision.waitMs };
  return { ...base, disposition: decision.verdict === 'ready' ? 'ready' : 'exhausted', waitMs: 0 };
}

function indicesOf(
  slots: readonly MeetingQueueSlot[],
  disposition: MeetingQueueDisposition,
): readonly number[] {
  return slots.filter((slot) => slot.disposition === disposition).map((slot) => slot.index);
}
