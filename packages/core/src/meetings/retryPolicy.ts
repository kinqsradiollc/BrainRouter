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
 * There is deliberately NO jitter, unlike `mcp/reconnect`. Jitter exists to
 * de-synchronize many clients against one server; here a single client drains
 * its own queue, so there is no herd to spread — and a deterministic schedule is
 * what lets the two hosts, and these tests, agree on when the next attempt is
 * due.
 */
import { isTerminalCaptureStatus } from './captureSession.js';
import type { MeetingCaptureSession, MeetingSegment } from './types.js';

export interface MeetingRetryPolicy {
  /** Total attempts a segment may make, including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
}

/**
 * Four attempts over roughly half a minute: long enough to ride out a sidecar
 * restart or a lost network, short enough that a genuinely broken endpoint stops
 * hiding behind "retrying" and becomes a visible gap the user can act on.
 */
export const DEFAULT_MEETING_RETRY_POLICY: MeetingRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  factor: 2,
  maxDelayMs: 60_000,
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
 * The segments a host should attempt right now.
 *
 * A terminal session yields none: under D6 its audio is deleted once the meeting
 * is accepted or discarded, so retrying from a file that no longer exists is a
 * request that can only fail.
 */
export function retryableSegments(
  session: MeetingCaptureSession,
  options: MeetingRetryOptions = {},
): readonly MeetingSegment[] {
  if (isTerminalCaptureStatus(session.status)) return [];
  return session.segments.filter((segment) => retryDecision(segment, options).verdict === 'ready');
}

/** True once every failed segment has spent its budget — the point at which a host stops draining. */
export function retriesExhausted(
  session: MeetingCaptureSession,
  options: MeetingRetryOptions = {},
): boolean {
  const failed = session.segments.filter((segment) => segment.state === 'failed');
  if (!failed.length) return false;
  return failed.every((segment) => retryDecision(segment, options).verdict === 'exhausted');
}
