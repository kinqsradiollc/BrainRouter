/**
 * ADR-035 D5/D7 — how often a failed segment is retried, as data.
 *
 * D5 says retries are "bounded and backed off" and D7 says a queued segment
 * drains when the endpoint returns. Both hosts have to obey the same rule, and
 * the reliable way to get that is not to write the rule down twice: the policy
 * is a plain record, the schedule is a pure function of the segment, and the
 * only thing a host contributes is the clock.
 *
 * The bound is what makes the retry safe to run automatically. Without it a
 * black-holed endpoint (§6's second supporting criterion) turns 120 segments
 * into an infinite loop of uploads, and the gap the user was supposed to see and
 * fix never settles long enough to be seen.
 *
 * There are TWO bounds here, because there are two ways to loop for ever.
 * `maxAttempts` bounds verdicts on the AUDIO — the ordinary D5 budget.
 * `maxDeferrals` bounds the refunds D7 grants for verdicts on the SERVER: an
 * outage costs no attempt, but "costs no attempt" must not mean "may recur
 * without limit", or a caller that misreports a permanent failure as a
 * temporary one keeps a segment at `attempts: 0` and in flight for ever. The
 * queue is not entitled to assume a status line is honest.
 *
 * There is deliberately NO jitter, unlike `mcp/reconnect`. Jitter exists to
 * de-synchronize many clients against one server; here a single client drains
 * its own queue, so there is no herd to spread — and a deterministic schedule is
 * what lets the two hosts, and these tests, agree on when the next attempt is
 * due.
 */
import type { MeetingSegment } from './types.js';

export interface MeetingRetryPolicy {
  /** Total attempts a segment may make, including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  /**
   * D7 — how many times an outage may be refunded to ONE segment before an
   * outage starts costing an attempt like any other failure.
   *
   * This is the bound on the give-back, and it is a separate axis from
   * `maxAttempts` on purpose. Without it, "an outage does not count" reads as
   * "an outage may happen for ever": a segment answered every time with a
   * try-again-later status sits at `attempts: 0`, `planTranscription` keeps
   * calling it ready, and the queue re-uploads the same bytes until the process
   * dies. That is not hypothetical — a gateway that reports one status for both
   * "the sidecar is down" and "ffmpeg cannot decode these bytes" produces
   * exactly it, and the transcript never says a word about the segment that will
   * never work.
   */
  readonly maxDeferrals: number;
}

/**
 * Four attempts over roughly half a minute: long enough to ride out a sidecar
 * restart or a lost network, short enough that a genuinely broken endpoint stops
 * hiding behind "retrying" and becomes a visible gap the user can act on.
 *
 * `maxDeferrals` is sized from the probe rate rather than guessed. During an
 * outage the queue backs off on this same curve, capped at `maxDelayMs`, so a
 * segment at the head of the queue is probed at most about once a minute: ten
 * minutes of a genuinely dead endpoint costs it roughly ten to fourteen refunds.
 * Twenty-four is comfortably more than double that, so §6's "point the endpoint
 * at a black hole for sixty seconds" — and a real ten-minute outage — still cost
 * a meeting nothing at all, while an endpoint that is down (or lying) for good
 * stops being refunded after ~20 minutes and the ordinary D5 bound finishes the
 * job.
 */
export const DEFAULT_MEETING_RETRY_POLICY: MeetingRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  factor: 2,
  maxDelayMs: 60_000,
  maxDeferrals: 24,
};

/**
 * `ready` — attempt it now; `waiting` — backing off, `waitMs` says how long;
 * `exhausted` — the bound is spent and this stays a gap until a person asks for
 * it again; `not-retryable` — the segment did not fail.
 */
export type MeetingRetryVerdict = 'ready' | 'waiting' | 'exhausted' | 'not-retryable';

export interface MeetingRetryDecision {
  readonly verdict: MeetingRetryVerdict;
  readonly attempts: number;
  readonly remainingAttempts: number;
  /** Milliseconds until the next attempt is due; 0 unless `waiting`. */
  readonly waitMs: number;
}

/** Delay before the attempt that follows `attempts` failures. Exponential, capped. */
export function retryDelayMs(attempts: number, policy: MeetingRetryPolicy = DEFAULT_MEETING_RETRY_POLICY): number {
  const spent = Math.max(1, Math.floor(attempts));
  const raw = policy.baseDelayMs * Math.pow(policy.factor, spent - 1);
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

export interface MeetingRetryOptions {
  readonly policy?: MeetingRetryPolicy;
  /** Epoch milliseconds. Passed explicitly so the schedule is testable. */
  readonly nowMs?: number;
}

export function retryDecision(segment: MeetingSegment, options: MeetingRetryOptions = {}): MeetingRetryDecision {
  const policy = options.policy ?? DEFAULT_MEETING_RETRY_POLICY;
  const remainingAttempts = Math.max(0, policy.maxAttempts - segment.attempts);
  if (segment.state !== 'failed') {
    return { verdict: 'not-retryable', attempts: segment.attempts, remainingAttempts, waitMs: 0 };
  }
  if (remainingAttempts <= 0) {
    return { verdict: 'exhausted', attempts: segment.attempts, remainingAttempts: 0, waitMs: 0 };
  }
  const nowMs = options.nowMs ?? Date.now();
  const lastAttemptMs = segment.lastAttemptAt ? Date.parse(segment.lastAttemptAt) : Number.NaN;
  // An unparseable or absent stamp means we cannot prove a backoff is owed, and
  // refusing to retry is the worse error: it would strand the segment forever.
  if (!Number.isFinite(lastAttemptMs)) {
    return { verdict: 'ready', attempts: segment.attempts, remainingAttempts, waitMs: 0 };
  }
  const waitMs = Math.max(0, lastAttemptMs + retryDelayMs(segment.attempts, policy) - nowMs);
  return {
    verdict: waitMs > 0 ? 'waiting' : 'ready',
    attempts: segment.attempts,
    remainingAttempts,
    waitMs,
  };
}

/**
 * D7 — has this segment used up the outages it is allowed to be forgiven?
 *
 * The queue asks this before refunding an attempt. `true` does NOT doom the
 * segment: it means the next outage is charged like any other failure, so the
 * ordinary bounded retry in `retryDecision` takes over and the segment either
 * transcribes when the endpoint returns or becomes a stated gap. That is the
 * difference between "we stop being infinitely credulous" and "we give up".
 *
 * Deliberately NOT folded into `retryDecision`: that answers "may this failed
 * segment be attempted again, and when", which is about the audio's budget.
 * This is about the server's credit, a segment can be `pending` while it is
 * spent, and merging the two would make one verdict mean two things.
 *
 * There is no per-session or wall-clock variant of this bound, and that is a
 * choice rather than an omission. Marking a segment we never probed as "could
 * not be transcribed" would be a lie of exactly the kind D5 exists to prevent,
 * and a wall-clock deadline would fire on a laptop that merely slept. So the
 * counter only moves when a real request really failed, and a permanently dead
 * endpoint converts a meeting to gaps front-to-back at the probe rate — slowly,
 * but never faster than the truth arrives.
 */
export function deferralsExhausted(segment: MeetingSegment, options: MeetingRetryOptions = {}): boolean {
  const policy = options.policy ?? DEFAULT_MEETING_RETRY_POLICY;
  return (segment.deferrals ?? 0) >= policy.maxDeferrals;
}
