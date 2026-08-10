/**
 * ADR-035 D5/D7 — retry is bounded, backed off, and identical on both hosts.
 *
 * The bound is the point. §6 asks for a black-holed endpoint mid-meeting; with
 * no bound that is an infinite upload loop and the gap the user was meant to see
 * never settles. These tests pin the schedule to explicit clock values so the
 * two hosts cannot drift into two different definitions of "retried enough".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  createCaptureSession,
  DEFAULT_MEETING_RETRY_POLICY,
  DEFAULT_MEETING_SEGMENT_MS,
  deferralsExhausted,
  discardCapture,
  markDone,
  markFailed,
  markTranscribing,
  planTranscription,
  requeueSegment,
  retryDecision,
  retryDelayMs,
  type MeetingCaptureSession,
  type MeetingRetryPolicy,
} from '../meetings/index.js';

const T0 = '2026-08-09T09:00:00.000Z';
const T0_MS = Date.parse(T0);

function oneSegment(): MeetingCaptureSession {
  const session = createCaptureSession({ id: 'mtg-retry', scope: { orgId: null }, startedAt: T0 });
  return appendSegment(session, { byteLength: 4096, durationMs: DEFAULT_MEETING_SEGMENT_MS });
}

/** Fail the segment `times` times, each attempt announced, all stamped at T0. */
function failed(times: number, session: MeetingCaptureSession = oneSegment()): MeetingCaptureSession {
  let next = session;
  for (let i = 0; i < times; i += 1) {
    next = markFailed(markTranscribing(next, 0, T0), 0, 'endpoint unreachable', T0);
  }
  return next;
}

test('the shared segment cadence sits inside the ADR range', () => {
  assert.ok(DEFAULT_MEETING_SEGMENT_MS >= 15_000 && DEFAULT_MEETING_SEGMENT_MS <= 30_000);
});

test('backoff is exponential, capped, and deterministic', () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(3), 8_000);
  assert.equal(retryDelayMs(20), DEFAULT_MEETING_RETRY_POLICY.maxDelayMs, 'the delay is capped, not unbounded');
  assert.equal(retryDelayMs(0), retryDelayMs(1), 'a nonsensical attempt count still yields the first delay');
  // Determinism is the contract: no jitter, so both hosts schedule the same instant.
  assert.equal(retryDelayMs(3), retryDelayMs(3));
});

test('D5 — retry is bounded: the fourth failure exhausts the segment', () => {
  const policy = DEFAULT_MEETING_RETRY_POLICY;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    const decision = retryDecision(failed(attempt).segments[0]!, { nowMs: T0_MS + 10_000_000 });
    assert.equal(decision.verdict, 'ready', `attempt ${attempt} should still be retryable`);
    assert.equal(decision.remainingAttempts, policy.maxAttempts - attempt);
  }
  const spent = retryDecision(failed(policy.maxAttempts).segments[0]!, { nowMs: T0_MS + 10_000_000 });
  assert.equal(spent.verdict, 'exhausted');
  assert.equal(spent.attempts, policy.maxAttempts);
  assert.equal(spent.remainingAttempts, 0);
  assert.equal(spent.waitMs, 0);
});

test('a segment inside its backoff window is waiting, not ready', () => {
  const segment = failed(1).segments[0]!;
  const tooSoon = retryDecision(segment, { nowMs: T0_MS + 500 });
  assert.equal(tooSoon.verdict, 'waiting');
  assert.equal(tooSoon.waitMs, 1_500);
  const due = retryDecision(segment, { nowMs: T0_MS + 2_000 });
  assert.equal(due.verdict, 'ready');
  assert.equal(due.waitMs, 0);
});

test('only failed segments are retry candidates', () => {
  const pending = oneSegment().segments[0]!;
  assert.equal(retryDecision(pending).verdict, 'not-retryable');
  const settled = markDone(markTranscribing(oneSegment(), 0, T0), 0, 'text').segments[0]!;
  assert.equal(retryDecision(settled).verdict, 'not-retryable');
  const inFlight = markTranscribing(oneSegment(), 0, T0).segments[0]!;
  assert.equal(retryDecision(inFlight).verdict, 'not-retryable');
});

test('a failure with no usable timestamp is retried rather than stranded', () => {
  const segment = { ...failed(1).segments[0]!, lastAttemptAt: undefined };
  assert.equal(retryDecision(segment, { nowMs: T0_MS }).verdict, 'ready');
  const corrupt = { ...failed(1).segments[0]!, lastAttemptAt: 'not-a-date' };
  assert.equal(retryDecision(corrupt, { nowMs: T0_MS }).verdict, 'ready');
});

test('a custom policy is obeyed in full — the rule is data, not a constant', () => {
  const policy: MeetingRetryPolicy = {
    maxAttempts: 2,
    baseDelayMs: 100,
    factor: 10,
    maxDelayMs: 500,
    maxDeferrals: 3,
  };
  assert.equal(retryDelayMs(1, policy), 100);
  assert.equal(retryDelayMs(2, policy), 500);
  assert.equal(retryDecision(failed(2).segments[0]!, { policy, nowMs: T0_MS + 1_000 }).verdict, 'exhausted');
});

// The two questions below used to have their own session-level helpers beside
// `planTranscription`, which answers both while the production queue reads only
// the plan. Two answers to one question is how the hosts end up disagreeing
// about when a meeting is out of retries, so the plan is asked directly.
test('D7 — the plan offers exactly the segments due right now', () => {
  let session = oneSegment();
  session = appendSegment(session, { byteLength: 4096, durationMs: DEFAULT_MEETING_SEGMENT_MS });
  session = appendSegment(session, { byteLength: 4096, durationMs: DEFAULT_MEETING_SEGMENT_MS });
  session = markDone(markTranscribing(session, 0, T0), 0, 'settled');
  session = markFailed(markTranscribing(session, 1, T0), 1, 'endpoint unreachable', T0);
  session = markFailed(markTranscribing(session, 2, T0), 2, 'endpoint unreachable', '2026-08-09T09:00:30.000Z');
  const due = planTranscription(session, { nowMs: T0_MS + 5_000 });
  assert.deepEqual(due.ready, [1], 'segment 2 is still inside its backoff window');
  assert.deepEqual(due.waiting, [2]);
  assert.deepEqual(planTranscription(session, { nowMs: T0_MS + 60_000 }).ready, [1, 2]);
});

test('D6 — a discarded meeting is never retried; its audio is gone', () => {
  const plan = planTranscription(discardCapture(failed(1)), { nowMs: T0_MS + 60_000 });
  assert.equal(plan.phase, 'closed');
  assert.deepEqual(plan.ready, []);
});

test('exhaustion is reported for the session so a host knows when to stop draining', () => {
  const clean = markDone(markTranscribing(oneSegment(), 0, T0), 0, 'text');
  assert.equal(planTranscription(clean).phase, 'idle', 'nothing left to do, and nothing owed');
  assert.deepEqual(planTranscription(clean).exhausted, []);
  assert.deepEqual(planTranscription(failed(1), { nowMs: T0_MS + 60_000 }).ready, [0]);
  const spent = planTranscription(failed(DEFAULT_MEETING_RETRY_POLICY.maxAttempts), { nowMs: T0_MS + 60_000 });
  assert.deepEqual(spent.exhausted, [0]);
  assert.equal(spent.phase, 'idle', 'the queue stops on its own rather than looping');
});

test('D7 — the refund an outage earns is counted, and the count is bounded', () => {
  // A refunded attempt leaves the segment pending with its budget intact, which
  // is the whole of D7. What is NOT in D7 is that this may happen for ever: an
  // endpoint that answers "try again later" for audio it can never decode would
  // otherwise hold the segment at attempts 0 and re-upload it until the process
  // dies. So each refund is written down.
  let session = oneSegment();
  assert.equal(deferralsExhausted(session.segments[0]!), false, 'a fresh segment has spent nothing');

  for (let round = 1; round <= DEFAULT_MEETING_RETRY_POLICY.maxDeferrals; round += 1) {
    session = requeueSegment(markTranscribing(session, 0, T0), 0, undefined, T0);
    const segment = session.segments[0]!;
    assert.equal(segment.state, 'pending', `round ${round} gives the attempt back`);
    assert.equal(segment.attempts, 0, 'an outage never costs the audio its budget');
    assert.equal(segment.deferrals, round, 'but the refund itself is recorded');
  }

  assert.equal(deferralsExhausted(session.segments[0]!), true, 'the credit runs out eventually');
  // Ten minutes of a genuinely dead endpoint costs a head-of-queue segment
  // roughly ten to fourteen probes, so the bound must sit well clear of that or
  // §6's outage criterion fails on a real outage.
  assert.ok(DEFAULT_MEETING_RETRY_POLICY.maxDeferrals >= 20, 'a ten-minute outage still costs nothing');
});
