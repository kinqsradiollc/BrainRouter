/**
 * ADR-035 D3/D5/D7 — the queue that actually drives a meeting to text.
 *
 * These tests cover the four ways a naive drain loop loses a meeting, because
 * each of them is silent when it happens:
 *
 * - it fires every segment at the sidecar at once, and the sidecar answering
 *   none of them looks exactly like a capture that failed;
 * - it spends a segment's retry budget on an outage, so a few minutes of a dead
 *   endpoint permanently marks a good meeting as gaps;
 * - it keeps its work list in memory, so a restart either redoes settled
 *   segments or forgets unfinished ones;
 * - it drops a segment it gave up on, leaving a transcript that is quietly
 *   wrong rather than one that says what is missing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSegment,
  createCaptureSession,
  createMeetingTranscriptionQueue,
  DEFAULT_MEETING_RETRY_POLICY,
  DEFAULT_MEETING_SEGMENT_MS,
  discardCapture,
  drainWakeDelayMs,
  finalizeCapture,
  MEETING_ENDPOINT_UNRESPONSIVE_REASON,
  MEETING_GAP_PHRASE,
  MEETING_INTERRUPTED_REASON,
  MEETING_MIN_WAKE_MS,
  planTranscription,
  retryDelayMs,
  stopCapture,
  transcriptGaps,
  transcriptSoFar,
  transcriptText,
  MeetingEndpointUnavailableError,
  classifyTranscriptionFailure,
  type MeetingCaptureSession,
  type MeetingTranscriptionPorts,
  type MeetingTranscriptionQueueOptions,
} from '../meetings/index.js';

const T0 = '2026-08-09T09:00:00.000Z';
const T0_MS = Date.parse(T0);

/** A session with `count` segments already written to disk (D1 happened first). */
function recorded(count: number): MeetingCaptureSession {
  let session = createCaptureSession({ id: 'mtg-queue', scope: { orgId: null }, startedAt: T0 });
  for (let i = 0; i < count; i += 1) {
    session = appendSegment(session, { byteLength: 4_096, durationMs: DEFAULT_MEETING_SEGMENT_MS });
  }
  return session;
}

interface Harness {
  /** Every `readSegment`, in order — the proof of which segments were re-attempted. */
  readonly reads: number[];
  /** Every `transcribe`, in order. */
  readonly calls: number[];
  /** Every session the queue asked the host to write down. */
  readonly persists: MeetingCaptureSession[];
  /** Requests outstanding at the endpoint right now, and the high-water mark. */
  live: number;
  peak: number;
  nowMs: number;
}

type Behaviour = (index: number) => Promise<string>;

function harness(
  session: MeetingCaptureSession,
  behaviour: Behaviour,
  options: Partial<Omit<MeetingTranscriptionQueueOptions, 'session' | 'ports'>> = {},
) {
  const state: Harness = { reads: [], calls: [], persists: [], live: 0, peak: 0, nowMs: T0_MS };
  const ports: MeetingTranscriptionPorts = {
    readSegment(index) {
      state.reads.push(index);
      // The index travels in the bytes so the fake endpoint knows what it was sent.
      return new Uint8Array([index]);
    },
    async transcribe(audio) {
      const index = audio[0]!;
      state.calls.push(index);
      state.live += 1;
      state.peak = Math.max(state.peak, state.live);
      try {
        return await behaviour(index);
      } finally {
        state.live -= 1;
      }
    },
    persist(next) {
      state.persists.push(next);
    },
    now: () => state.nowMs,
  };
  return { state, queue: createMeetingTranscriptionQueue({ session, ports, ...options }) };
}

/** Let every pending microtask and timer callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const succeed: Behaviour = async (index) => `segment ${index}`;

test('D3 — a drain transcribes every segment and settles the transcript', async () => {
  const { queue, state } = harness(recorded(3), succeed);
  const result = await queue.drain();
  assert.equal(result.phase, 'idle');
  assert.equal(result.nextWakeMs, null);
  assert.deepEqual(result.transcribed, [0, 1, 2]);
  assert.deepEqual(transcriptGaps(result.session), []);
  assert.deepEqual(state.reads, [0, 1, 2]);
  assert.equal(transcriptText(result.session), 'segment 0\nsegment 1\nsegment 2');
  assert.ok(result.session.segments.every((segment) => segment.state === 'done' && segment.attempts === 1));
});

test('concurrency stays bounded — a meeting is not 120 simultaneous uploads', async () => {
  // Eight stands in for a real meeting's ~180 segments; the property under test
  // is the bound, and the bound does not care how long the queue is.
  const gates = new Map<number, () => void>();
  const { queue, state } = harness(
    recorded(8),
    (index) => new Promise<string>((resolve) => gates.set(index, () => resolve(`segment ${index}`))),
    { maxInFlight: 2 },
  );

  const draining = queue.drain();
  await flush();
  assert.equal(state.live, 2, 'the queue opens exactly two requests, not eight');
  assert.deepEqual([...gates.keys()], [0, 1], 'and it starts at the front of the meeting');

  while (gates.size) {
    const [index, release] = [...gates.entries()][0]!;
    gates.delete(index);
    release();
    await flush();
    assert.ok(state.live <= 2, `the bound held while segment ${index} settled`);
  }

  const result = await draining;
  assert.equal(state.peak, 2, 'both slots are used — the bound is a ceiling, not a serializer');
  assert.equal(result.phase, 'idle');
  assert.equal(result.session.segments.filter((segment) => segment.state === 'done').length, 8);
});

test('D7 — a downed endpoint does not consume the retry budget', async () => {
  const { queue, state } = harness(recorded(3), async () => {
    throw new MeetingEndpointUnavailableError();
  });

  // Ten outages, which is more than twice the retry bound. If an outage counted,
  // every segment would be permanently exhausted long before this loop ended.
  for (let round = 0; round < 10; round += 1) {
    const result = await queue.drain();
    assert.equal(result.phase, 'unavailable', `round ${round} should report the endpoint, not the audio`);
    assert.ok(result.nextWakeMs !== null && result.nextWakeMs > 0, 'and say when to try again');
    assert.deepEqual(transcriptGaps(result.session), [], 'an outage is not a gap in the transcript');
    state.nowMs += result.nextWakeMs!;
  }

  assert.ok(
    queue.session.segments.every((segment) => segment.state === 'pending' && segment.attempts === 0),
    'every segment is still queued with its full budget intact',
  );
  assert.deepEqual(planTranscription(queue.session, { nowMs: state.nowMs }).exhausted, []);
  assert.ok(state.calls.length > 0, 'the endpoint was genuinely probed each round');
});

test('D7 — the queue drains itself when the endpoint comes back', async () => {
  let up = false;
  const { queue, state } = harness(recorded(3), async (index) => {
    if (!up) throw new MeetingEndpointUnavailableError();
    return `segment ${index}`;
  });

  const down = await queue.drain();
  assert.equal(down.phase, 'unavailable');
  up = true;
  state.nowMs += down.nextWakeMs!;

  const back = await queue.drain();
  assert.equal(back.phase, 'idle');
  assert.deepEqual(transcriptGaps(back.session), []);
  assert.equal(transcriptText(back.session), 'segment 0\nsegment 1\nsegment 2');
  assert.ok(back.session.segments.every((segment) => segment.attempts === 1), 'the outage attempts were refunded');
});

test('D7 — the queue honours its own cooldown instead of hammering a struggling sidecar', async () => {
  const { queue, state } = harness(recorded(2), async () => {
    throw new MeetingEndpointUnavailableError();
  });
  const first = await queue.drain();
  const probes = state.calls.length;
  const second = await queue.drain(); // no clock movement: still inside the cooldown
  assert.equal(second.phase, 'unavailable');
  assert.equal(state.calls.length, probes, 'a re-drain inside the cooldown touches nothing');
  assert.ok(second.nextWakeMs !== null && second.nextWakeMs <= first.nextWakeMs!);
});

test('D7 — an endpoint that never answers stops being forgiven, and the segment becomes a gap', async () => {
  // The defect this test exists for: a gateway that reports "ffmpeg could not
  // decode these bytes" with the same 502 it uses for "the sidecar is down".
  // Every drain then refunds the attempt, the segment returns to pending with
  // attempts 0, `gaps` stays empty, and the queue re-uploads the same audio
  // against our own sidecar for ever while the surface says it is still coming.
  // The queue is not entitled to believe a status line indefinitely.
  const { queue, state } = harness(recorded(1), async () => {
    throw Object.assign(new Error('stt_unavailable'), { status: 502 });
  });

  let result = await queue.drain();
  let rounds = 1;
  /** The last instant at which the outage had cost this segment nothing at all. */
  let freeUntilMs = -1;
  while (result.nextWakeMs !== null && rounds < 200) {
    state.nowMs += result.nextWakeMs;
    result = await queue.drain();
    rounds += 1;
    if (result.session.segments[0]!.attempts === 0) freeUntilMs = state.nowMs - T0_MS;
  }

  assert.ok(rounds < 200, 'the drain loop terminates on its own rather than running for ever');
  assert.equal(result.phase, 'idle', 'and it stops asking the host to come back');
  assert.equal(result.nextWakeMs, null);
  assert.ok(
    freeUntilMs >= 10 * 60_000,
    `a genuine ten-minute outage must still cost nothing (forgiven for ${freeUntilMs}ms)`,
  );

  const segment = result.session.segments[0]!;
  assert.equal(segment.deferrals, DEFAULT_MEETING_RETRY_POLICY.maxDeferrals, 'the refunds ran out');
  assert.equal(segment.attempts, DEFAULT_MEETING_RETRY_POLICY.maxAttempts, 'then the ordinary bound closed it out');
  assert.equal(segment.state, 'failed');
  assert.equal(segment.failureReason, MEETING_ENDPOINT_UNRESPONSIVE_REASON, 'and it says the endpoint, not the audio');

  const gaps = transcriptGaps(result.session);
  assert.equal(gaps.length, 1, 'the transcript states what is missing instead of claiming it is coming');
  assert.ok(gaps[0]!.text.includes(MEETING_GAP_PHRASE));
  assert.deepEqual(planTranscription(result.session, { nowMs: state.nowMs }).ready, []);
});

test('D5 — a real failure spends the budget and ends as a stated gap', async () => {
  const { queue, state } = harness(recorded(1), async () => {
    throw new Error('The audio could not be decoded.');
  });

  for (let attempt = 1; attempt < DEFAULT_MEETING_RETRY_POLICY.maxAttempts; attempt += 1) {
    const result = await queue.drain();
    assert.deepEqual(result.failed, [0]);
    assert.equal(result.phase, 'waiting', 'a bounded retry is still owed');
    assert.equal(result.nextWakeMs, retryDelayMs(attempt), 'and it is the shared backoff, not a second rule');
    assert.equal(result.session.segments[0]!.attempts, attempt);
    state.nowMs += result.nextWakeMs!;
  }

  const spent = await queue.drain();
  assert.equal(spent.phase, 'idle', 'the bound is reached and the queue stops on its own');
  assert.equal(spent.nextWakeMs, null);
  assert.equal(spent.session.segments[0]!.attempts, DEFAULT_MEETING_RETRY_POLICY.maxAttempts);
  assert.equal(spent.session.segments[0]!.failureReason, 'The audio could not be decoded.');
  assert.deepEqual(planTranscription(spent.session, { nowMs: state.nowMs }).exhausted, [0]);

  // …and it is a gap in the transcript, not an omission.
  const gaps = transcriptGaps(spent.session);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.index, 0);
  assert.ok(gaps[0]!.text.includes(MEETING_GAP_PHRASE));
  assert.equal(transcriptSoFar(spent.session).length, spent.session.segments.length);

  const stillSpent = await queue.drain();
  assert.deepEqual(stillSpent.failed, [], 'an exhausted segment is not retried again on its own');
});

test('D5 — an exhausted segment keeps its neighbours intact and never disappears', async () => {
  const { queue, state } = harness(recorded(3), async (index) => {
    if (index === 1) throw new Error('unsupported audio');
    return `segment ${index}`;
  });

  let result = await queue.drain();
  while (result.phase === 'waiting') {
    state.nowMs += result.nextWakeMs!;
    result = await queue.drain();
  }

  assert.equal(result.phase, 'idle');
  const entries = transcriptSoFar(result.session);
  assert.equal(entries.length, 3, 'no segment is filtered out of a transcript');
  assert.deepEqual(entries.map((entry) => entry.kind), ['settled', 'gap', 'settled']);
  const text = transcriptText(result.session);
  assert.ok(text.startsWith('segment 0\n['), 'the gap sits where the missing minute is');
  assert.ok(text.includes(MEETING_GAP_PHRASE));
  assert.ok(text.endsWith('segment 2'));
});

test('D5 — a person can retry an exhausted gap, and it is one attempt, not a reset', async () => {
  let broken = true;
  const { queue, state } = harness(recorded(1), async (index) => {
    if (broken) throw new Error('unsupported audio');
    return `segment ${index}`;
  });

  let result = await queue.drain();
  while (result.phase === 'waiting') {
    state.nowMs += result.nextWakeMs!;
    result = await queue.drain();
  }
  const spentCalls = state.calls.length;
  await queue.drain();
  assert.equal(state.calls.length, spentCalls, 'the automatic queue has stopped');

  broken = false;
  const retried = await queue.retry(0);
  assert.equal(state.calls.length, spentCalls + 1, 'a person asking is worth exactly one request');
  assert.equal(retried.session.segments[0]!.state, 'done');
  assert.deepEqual(transcriptGaps(retried.session), []);
});

test('§6 — a restart resumes exactly the segments that were unfinished', async () => {
  // First run: segments 0 and 1 settle, then the endpoint dies while segment 2 is
  // in flight. The snapshot the host had on disk at that instant is the one a
  // killed application comes back to.
  const first = harness(
    recorded(4),
    async (index) => {
      if (index >= 2) throw new MeetingEndpointUnavailableError();
      return `segment ${index}`;
    },
    { maxInFlight: 1 },
  );
  await first.queue.drain();
  const killed = first.state.persists.find(
    (snapshot) => snapshot.segments[2]?.state === 'transcribing' && snapshot.segments[0]?.state === 'done',
  );
  assert.ok(killed, 'the in-flight attempt was written down before the request was made');

  // Second run: a brand-new queue over nothing but the persisted record.
  const second = harness(killed, succeed, { maxInFlight: 1 });
  second.state.nowMs = T0_MS + 60_000; // the app was closed for a minute
  let result = await second.queue.drain();
  // The interrupted segment serves one backoff before its retry — the same rule
  // `recoverCaptureSession` applies, so a crash loop cannot become a hot loop.
  while (result.phase === 'waiting') {
    second.state.nowMs += result.nextWakeMs!;
    result = await second.queue.drain();
  }

  assert.deepEqual([...second.state.reads].sort(), [2, 3], 'exactly the unfinished segments, and no others, were re-read');
  assert.equal(result.phase, 'idle');
  assert.deepEqual(transcriptGaps(result.session), []);
  assert.equal(result.session.segments[0]!.text, 'segment 0', 'settled text survived the restart untouched');
  assert.equal(result.session.segments[2]!.attempts, 2, 'the interrupted attempt still counts against the bound');
});

test('a segment left mid-attempt by a dead process stops claiming to be transcribing', async () => {
  const onDisk = recorded(1);
  const midAttempt: MeetingCaptureSession = {
    ...onDisk,
    segments: [{ ...onDisk.segments[0]!, state: 'transcribing', attempts: 1, lastAttemptAt: T0 }],
  };
  const { queue, state } = harness(midAttempt, async () => {
    throw new MeetingEndpointUnavailableError();
  });
  state.nowMs = T0_MS + 60_000;
  const result = await queue.drain();
  const reasons = state.persists.map((snapshot) => snapshot.segments[0]!.failureReason);
  assert.ok(reasons.includes(MEETING_INTERRUPTED_REASON), 'recovery states why, rather than showing a spinner');
  assert.notEqual(result.session.segments[0]!.state, 'transcribing');
});

test('unreadable audio is the segment’s failure, not the endpoint’s', async () => {
  const state = { reads: 0 };
  const queue = createMeetingTranscriptionQueue({
    session: recorded(1),
    ports: {
      readSegment() {
        state.reads += 1;
        throw new Error('ENOENT: the capture file is gone');
      },
      transcribe() {
        throw new Error('the endpoint should never have been asked');
      },
      persist() {},
      now: () => T0_MS,
    },
  });
  const result = await queue.drain();
  assert.deepEqual(result.failed, [0]);
  assert.equal(result.phase, 'waiting', 'it counts, so it backs off and eventually becomes a gap');
  assert.equal(result.session.segments[0]!.attempts, 1);
});

test('D6 — a finalized or discarded meeting is never touched', async () => {
  for (const session of [
    finalizeCapture(stopCapture(recorded(2))),
    discardCapture(recorded(2)),
  ]) {
    const { queue, state } = harness(session, succeed);
    const result = await queue.drain();
    assert.equal(result.phase, 'closed');
    assert.deepEqual(state.reads, [], 'its audio is deleted; reading it could only fail');
    assert.deepEqual(state.calls, []);
  }
});

test('D2 — the host appends through the queue and every transition is written down', async () => {
  const { queue, state } = harness(recorded(0), succeed);
  await queue.apply((session) => appendSegment(session, { byteLength: 2_048, durationMs: DEFAULT_MEETING_SEGMENT_MS }));
  assert.equal(state.persists.length, 1, 'the record is written before anything else happens to it');
  assert.equal(queue.session.segments.length, 1);
  const result = await queue.drain();
  assert.deepEqual(result.transcribed, [0]);
  // Every transition persisted, including the in-flight one a crash would land on.
  assert.ok(state.persists.some((snapshot) => snapshot.segments[0]!.state === 'transcribing'));
  assert.equal(state.persists[state.persists.length - 1]!.segments[0]!.state, 'done');
});

test('a persist that throws is reported rather than swallowed', async () => {
  let allow = false;
  const queue = createMeetingTranscriptionQueue({
    session: recorded(1),
    ports: {
      readSegment: () => new Uint8Array([0]),
      transcribe: async () => 'segment 0',
      persist() {
        if (!allow) throw new Error('the disk is full');
      },
      now: () => T0_MS,
    },
  });
  const result = await queue.drain();
  assert.ok(result.errors.length > 0, 'a host whose writes are failing is about to lose a meeting');
  allow = true;
});

test('the outage classifier reads a server problem apart from an audio problem', () => {
  assert.equal(classifyTranscriptionFailure(new MeetingEndpointUnavailableError()), 'endpoint-unavailable');
  assert.equal(classifyTranscriptionFailure(Object.assign(new Error('down'), { code: 'ECONNREFUSED' })), 'endpoint-unavailable');
  assert.equal(classifyTranscriptionFailure(Object.assign(new Error('busy'), { status: 503 })), 'endpoint-unavailable');
  assert.equal(classifyTranscriptionFailure(new TypeError('Failed to fetch')), 'endpoint-unavailable');
  assert.equal(
    classifyTranscriptionFailure(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })),
    'endpoint-unavailable',
  );
  // Everything the server actually answered is about this audio, and counts.
  assert.equal(classifyTranscriptionFailure(Object.assign(new Error('too big'), { status: 413 })), 'segment');
  assert.equal(classifyTranscriptionFailure(Object.assign(new Error('bad request'), { status: 400 })), 'segment');
  assert.equal(classifyTranscriptionFailure(new Error('unsupported audio')), 'segment');
});

test('the re-drain floor lives with the schedule, so neither host invents its own', () => {
  // It only ever binds on the error path: the queue answers 0 when it stopped
  // with work still ready because a write failed and blocked a segment, and
  // honouring that literally spins a host against a store already refusing it.
  assert.equal(drainWakeDelayMs(0), MEETING_MIN_WAKE_MS);
  assert.equal(drainWakeDelayMs(1), MEETING_MIN_WAKE_MS);
  // Every real backoff this schedule produces starts far above the floor and is
  // passed through untouched — the floor is scheduling, not a retry rule.
  assert.equal(drainWakeDelayMs(DEFAULT_MEETING_RETRY_POLICY.baseDelayMs), DEFAULT_MEETING_RETRY_POLICY.baseDelayMs);
  assert.equal(drainWakeDelayMs(retryDelayMs(3)), retryDelayMs(3));
  assert.ok(MEETING_MIN_WAKE_MS < DEFAULT_MEETING_RETRY_POLICY.baseDelayMs);
  // `null` means only new work can change anything; there is nothing to schedule.
  assert.equal(drainWakeDelayMs(null), null);
  assert.equal(drainWakeDelayMs(Number.NaN), MEETING_MIN_WAKE_MS, 'never handed to a timer as "immediately"');
});

test('a blocked write asks to be woken again, and the floor makes that safe to honour', async () => {
  const queue = createMeetingTranscriptionQueue({
    session: recorded(1),
    ports: {
      readSegment: () => new Uint8Array([0]),
      transcribe: async () => 'segment 0',
      persist() { throw new Error('the disk is full'); },
      now: () => T0_MS,
    },
  });
  const result = await queue.drain();
  assert.equal(result.phase, 'waiting', 'work is still ready, so this is not idle');
  assert.equal(result.nextWakeMs, 0);
  assert.equal(drainWakeDelayMs(result.nextWakeMs), MEETING_MIN_WAKE_MS);
});
