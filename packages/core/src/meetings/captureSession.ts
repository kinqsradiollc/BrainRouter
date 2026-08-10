/**
 * ADR-035 D2/D3/D5 — the pure transitions of a meeting capture.
 *
 * Every function here takes a session and returns a NEW session; nothing is
 * mutated in place. That is not a style preference. Both hosts persist after
 * each transition (D1: bytes first, record second), and a mutated-in-place
 * record is one whose "before" no longer exists when the write that was meant
 * to save the "after" fails — which is the class of silent loss this ADR is
 * about.
 *
 * Two invariants this module enforces, because a host that got either wrong
 * would fail quietly:
 *
 * 1. **A session id names a directory.** D6 has the desktop create a `0700`
 *    capture directory per session and the browser an OPFS folder. An id
 *    containing `/` or `..` would be a traversal bug in every such host, so the
 *    model refuses to mint or accept one.
 * 2. **Settled text wins over a late arrival.** D4 says a user editing settled
 *    text must not have their edit overwritten by a late-arriving segment. A
 *    result for a segment that is already `done` is therefore dropped here, in
 *    the one place both hosts share, rather than in whichever surface remembered
 *    to guard against it.
 * 3. **A meeting someone is recording cannot be closed by someone else — and
 *    that is not decided here.** The two terminal transitions release the audio,
 *    so calling either on a live capture destroys a meeting in progress. For one
 *    round this module refused them by reading a heartbeat stamp off the record.
 *    A stamp cannot carry that: it says a writer was alive at an instant, not
 *    that one is alive now, so an application killed a second ago went on
 *    refusing Transcribe, Create and Delete over a recording nobody was making —
 *    and a renderer RELOAD, which leaves the record untouched, did the same for
 *    ever. Both hosts now answer liveness from something that dies with the
 *    writer (a per-process writer map; a Web Lock per browsing context) and ask
 *    it BEFORE these transitions. A guard here could only re-derive a worse
 *    answer from the record, so there is none.
 */
import type {
  MeetingCaptureScope,
  MeetingCaptureSession,
  MeetingCaptureStatus,
  MeetingCaptureTemplate,
  MeetingSegment,
} from './types.js';

/**
 * Open question 1 — segment length.
 *
 * The ADR names 15–30s and says it should be measured against transcription
 * quality rather than guessed, because too-short segments cut words in half.
 * Until that measurement exists, both hosts use the midpoint from one constant
 * instead of picking their own: a shared default that is provably identical on
 * both surfaces is worth more than a marginally better one that is not.
 */
export const DEFAULT_MEETING_SEGMENT_MS = 20_000;

/** Ids name directories (D6), so the alphabet is deliberately narrow. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The two states from which nothing further may be appended or transcribed. */
const TERMINAL_STATUSES: readonly MeetingCaptureStatus[] = ['finalized', 'discarded'];

/** D5 — what a segment interrupted by a crash says once recovery finds it. */
export const MEETING_INTERRUPTED_REASON = 'Transcription was interrupted before it finished.';

/** D5 — what an untranscribed segment says when the user finalizes anyway. */
export const MEETING_UNFINISHED_REASON = 'Not transcribed before the meeting was finalized.';

/** D7 — what a segment says while the endpoint is down. Not a verdict on the audio. */
export const MEETING_ENDPOINT_UNAVAILABLE_REASON = 'The transcription endpoint is unavailable.';

/**
 * D5/D7 — what a segment says once its outage refunds are spent.
 *
 * Distinct from `MEETING_ENDPOINT_UNAVAILABLE_REASON` because it means something
 * a user can act on that the other does not: we have stopped waiting for the
 * endpoint on this segment's behalf, so it is now on the ordinary retry budget
 * and heading for a stated gap. "Unavailable" forever is the spinner ADR-028
 * asks a surface not to show.
 */
export const MEETING_ENDPOINT_UNRESPONSIVE_REASON =
  'The transcription endpoint did not answer for this segment after many attempts.';

export interface CreateMeetingCaptureInput {
  /** Supply one to adopt a host-generated id; otherwise a random, path-safe id is minted. */
  readonly id?: string;
  readonly scope: MeetingCaptureScope;
  readonly title?: string;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
  /** ISO instant the recording started. Defaults to now; passed explicitly by tests. */
  readonly startedAt?: string;
}

export interface AppendMeetingSegmentInput {
  readonly byteLength: number;
  readonly durationMs: number;
  /** Elapsed-ms start. Defaults to the previous segment's end, which is the recorder's own cadence. */
  readonly startMs?: number;
}

export function isMeetingSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_SHAPE.test(value);
}

export function isTerminalCaptureStatus(status: MeetingCaptureStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Scope equality with the optional half normalized, so `undefined` and `null` are one workspace. */
export function sameCaptureScope(a: MeetingCaptureScope, b: MeetingCaptureScope): boolean {
  return a.orgId === b.orgId && (a.workspaceId ?? null) === (b.workspaceId ?? null);
}

/**
 * A path-safe random id. `crypto.randomUUID` is unavailable outside a secure
 * context, and the dashboard is not always served from one, so the fallback is
 * not decoration — without it a plain-http origin could not start a meeting.
 */
export function newMeetingSessionId(): string {
  const webcrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webcrypto?.randomUUID === 'function') return `mtg-${webcrypto.randomUUID()}`;
  return `mtg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * D2 — pressing Record creates the meeting. Everything after is an append to
 * something that already exists, which is what makes a crash recoverable rather
 * than merely detectable.
 */
export function createCaptureSession(input: CreateMeetingCaptureInput): MeetingCaptureSession {
  const id = input.id ?? newMeetingSessionId();
  if (!isMeetingSessionId(id)) {
    throw new Error('A meeting session id must be 1–128 characters of letters, digits, dash or underscore.');
  }
  return {
    id,
    startedAt: input.startedAt ?? new Date().toISOString(),
    scope: { orgId: input.scope.orgId, workspaceId: input.scope.workspaceId ?? null },
    title: input.title?.trim() || 'Untitled meeting',
    template: input.template ?? 'general',
    ...(input.language ? { language: input.language } : {}),
    status: 'recording',
    segments: [],
  };
}

/**
 * D1/D3 — the host has just written a chunk of audio down; record it.
 *
 * Called AFTER the bytes land, never before: a segment record is the model's
 * claim that audio for that range exists, and recovery believes it.
 */
export function appendSegment(
  session: MeetingCaptureSession,
  input: AppendMeetingSegmentInput,
): MeetingCaptureSession {
  if (session.status !== 'recording') {
    throw new Error(`Cannot append audio to a meeting that is ${session.status}.`);
  }
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    throw new Error('A meeting segment must carry at least one byte of audio.');
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    throw new Error('A meeting segment must cover a positive duration.');
  }
  const previousEnd = session.segments.length ? session.segments[session.segments.length - 1]!.endMs : 0;
  const startMs = input.startMs ?? previousEnd;
  // Ranges are what a gap marker prints (D5); overlapping or reversed ones would
  // make a stated gap unreadable, so they are refused rather than normalized.
  if (!Number.isFinite(startMs) || startMs < previousEnd) {
    throw new Error('A meeting segment cannot start before the previous segment ended.');
  }
  const segment: MeetingSegment = {
    index: session.segments.length,
    byteLength: Math.round(input.byteLength),
    startMs: Math.round(startMs),
    endMs: Math.round(startMs + input.durationMs),
    state: 'pending',
    attempts: 0,
  };
  return { ...session, segments: [...session.segments, segment] };
}

/** D3 — an attempt has begun. Spends one of the bounded attempts in `retryPolicy.ts`. */
export function markTranscribing(
  session: MeetingCaptureSession,
  index: number,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  return replaceSegment(session, index, (segment) => {
    if (segment.state !== 'pending' && segment.state !== 'failed') {
      throw new Error(`Segment ${index} cannot start transcribing from state ${segment.state}.`);
    }
    const { failureReason: _dropped, ...rest } = segment;
    return { ...rest, state: 'transcribing', attempts: segment.attempts + 1, lastAttemptAt: at };
  });
}

/**
 * D3/D4 — a segment settled.
 *
 * A result for an already-settled segment is DROPPED, not applied: D4 forbids a
 * late arrival overwriting text a user may already have edited. Returning the
 * session unchanged (rather than throwing) is deliberate — a duplicate result is
 * an ordinary distributed-systems event, not a host bug worth crashing a
 * recording over.
 */
export function markDone(session: MeetingCaptureSession, index: number, text: string): MeetingCaptureSession {
  return replaceSegment(session, index, (segment) => {
    if (segment.state === 'done') return segment;
    const { failureReason: _dropped, ...rest } = segment;
    return { ...rest, state: 'done', text };
  });
}

/**
 * D5 — a segment failed, visibly and with its reason kept.
 *
 * `attempts` is incremented only when the attempt was never announced through
 * `markTranscribing`, so the count is "attempts made" whichever call sequence a
 * host uses. The bound has to hold for both, or the host that skips the
 * announcement retries forever.
 */
export function markFailed(
  session: MeetingCaptureSession,
  index: number,
  reason: string,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  return replaceSegment(session, index, (segment) => {
    if (segment.state === 'done') return segment; // settled text wins over a late failure, same as D4
    const attempts = segment.state === 'transcribing' ? segment.attempts : segment.attempts + 1;
    return {
      ...segment,
      state: 'failed',
      failureReason: reason.trim() || 'Transcription failed.',
      attempts,
      lastAttemptAt: at,
    };
  });
}

/**
 * D7 — the endpoint was down, so no attempt on this audio ever happened.
 *
 * The dispatcher has to announce an attempt (`markTranscribing`) BEFORE it can
 * discover whether the endpoint answers, so an outage always arrives with an
 * attempt already spent. Left that way, every outage costs every queued segment
 * one of its four attempts, and a few minutes of a dead sidecar permanently
 * marks a perfectly good meeting as gaps — the exact silent loss this ADR
 * exists to end. So the attempt is GIVEN BACK here, and only here: "this
 * segment's audio is bad" is a verdict on the audio and counts; "the endpoint
 * is down" is a verdict on the server and does not.
 *
 * The state it lands in depends on what the give-back leaves behind:
 *
 * - **No attempts left over** — the segment was never really tried, so it is
 *   `pending`: D4's "queued because the endpoint is down".
 * - **Attempts still spent** — an earlier, genuine failure is still on this
 *   segment's record, so it stays `failed` and keeps saying so. Laundering it
 *   into `pending` would hide a segment that has already burned its budget
 *   behind a spinner, and would let the planner treat an exhausted segment as
 *   fresh work forever.
 *
 * `previousFailureReason` is what the segment said before this dispatch, which
 * `markTranscribing` cleared; passing it back keeps a specific diagnosis from
 * being overwritten by a generic one.
 *
 * The refund is COUNTED as well as granted (`deferrals`). Granting it without
 * counting it is what turns D7's "an outage costs no retry budget" into "an
 * outage may recur without limit": a caller that reports every failure as an
 * outage would hold a segment at `attempts: 0` for ever. The bound on the count
 * lives in `retryPolicy.ts` (`deferralsExhausted`) and is applied by the queue,
 * which is the single writer and the only thing that can see the endpoint.
 */
export function requeueSegment(
  session: MeetingCaptureSession,
  index: number,
  previousFailureReason?: string,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  return replaceSegment(session, index, (segment) => {
    // Only an announced attempt can be given back. Anything else is a caller
    // confusion, and returning the segment untouched is safer than inventing
    // an attempt to refund.
    if (segment.state !== 'transcribing') return segment;
    const attempts = Math.max(0, segment.attempts - 1);
    const deferrals = (segment.deferrals ?? 0) + 1;
    if (attempts === 0) {
      const { failureReason: _dropped, ...rest } = segment;
      return { ...rest, state: 'pending', attempts, deferrals, lastAttemptAt: at };
    }
    return {
      ...segment,
      state: 'failed',
      failureReason: previousFailureReason?.trim() || MEETING_ENDPOINT_UNAVAILABLE_REASON,
      attempts,
      deferrals,
      lastAttemptAt: at,
    };
  });
}

/** Capture ended; segments already on disk keep draining (D7). */
export function stopCapture(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  requireOpen(session, 'stop');
  if (session.status === 'stopped') return session;
  return { ...session, status: 'stopped', stoppedAt: at };
}

/** The "resume" half of what a recovered session offers (D2). */
export function resumeCapture(session: MeetingCaptureSession): MeetingCaptureSession {
  requireOpen(session, 'resume');
  if (session.status === 'recording') return session;
  const { stoppedAt: _cleared, ...rest } = session;
  return { ...rest, status: 'recording' };
}

/**
 * D5/D6 — the user accepted the meeting.
 *
 * Segments that never transcribed become stated gaps rather than disappearing.
 * Refusing to finalize while any segment is unsettled would be the stricter
 * rule, and it is the wrong one: under D7 a segment can sit queued indefinitely
 * while the endpoint is down, and a user who can never finalize is a user whose
 * audio is never released.
 *
 * "Is anybody still recording this?" is asked by the CALLER, before this
 * (invariant 3) — finalizing marks every unfinished segment as a gap and the
 * host then deletes the audio, so it is a real question, and the host is the
 * only thing that can answer it about a live process rather than about a stamp.
 */
export function finalizeCapture(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  requireOpen(session, 'finalize');
  const segments = session.segments.map((segment) =>
    segment.state === 'pending' || segment.state === 'transcribing'
      ? { ...segment, state: 'failed' as const, failureReason: MEETING_UNFINISHED_REASON, lastAttemptAt: at }
      : segment,
  );
  return { ...session, status: 'finalized', segments, stoppedAt: session.stoppedAt ?? at, closedAt: at };
}

/**
 * D6 — an explicit discard. The host deletes the audio; the record says why it
 * is gone.
 *
 * Guarded by its caller, like `finalizeCapture` and for the same reason. The
 * defect this ADR keeps circling is a second window or a second tab being
 * offered a LIVE recording back with an enabled Delete; what stops it now is
 * that neither host offers it, because neither host has to guess who is
 * recording.
 */
export function discardCapture(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  requireOpen(session, 'discard');
  return { ...session, status: 'discarded', stoppedAt: session.stoppedAt ?? at, closedAt: at };
}

/**
 * D2 — what a host applies to a persisted session at startup.
 *
 * THREE truths a crash leaves behind, and all are corrected here rather than
 * displayed: nothing is recording any more, a segment left mid-attempt did NOT
 * succeed, and — for records written by one earlier build — a `writer` stamp
 * claims somebody is still recording into this capture. Marking the second
 * failed rather than pending is the ADR-028 point: "Transcribing…" on a segment
 * whose process died twenty minutes ago is exactly the lie this ADR exists to
 * end. It keeps its spent attempt, so the retry bound still means something
 * across restarts.
 *
 * The third is a migration, and it is the same lie one level up. That build
 * answered "is somebody recording into this?" from a heartbeat stamp in the
 * record, and a stamp cannot say that — an application killed a second ago
 * leaves one that looks perfectly fresh, so the meeting was withheld from the
 * recovery offer for a whole staleness window, which is §6's headline failure.
 * Nothing reads the field any more (`types.ts` says why there will not be one
 * again), so it could simply be ignored; it is DROPPED instead, because a
 * record's own spread would otherwise carry a dead writer's name through every
 * later transition and out to disk for the life of the meeting. Recovery is the
 * one moment both hosts put a persisted record back together, so it is where the
 * field stops existing — and after a kill the status changed too, which is what
 * makes the host rewrite the record and the drop stick.
 */
export function recoverCaptureSession(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): MeetingCaptureSession {
  if (isTerminalCaptureStatus(session.status)) return session;
  const segments = session.segments.map((segment) =>
    segment.state === 'transcribing'
      ? { ...segment, state: 'failed' as const, failureReason: MEETING_INTERRUPTED_REASON, lastAttemptAt: at }
      : segment,
  );
  // Typed as unknown rather than as a lease: the shape is gone from the model,
  // and this is the only place that still has to know it was ever there.
  const { writer: _abandoned, ...carried } = session as MeetingCaptureSession & { writer?: unknown };
  return { ...carried, status: 'stopped', segments, stoppedAt: session.stoppedAt ?? at };
}

/** Total bytes of audio the host claims to hold for this session. */
export function capturedByteLength(session: MeetingCaptureSession): number {
  return session.segments.reduce((total, segment) => total + segment.byteLength, 0);
}

/** Segments that have neither settled nor failed — D4's provisional set. */
export function unsettledSegments(session: MeetingCaptureSession): readonly MeetingSegment[] {
  return session.segments.filter((segment) => segment.state === 'pending' || segment.state === 'transcribing');
}

function requireOpen(session: MeetingCaptureSession, verb: string): void {
  if (isTerminalCaptureStatus(session.status)) {
    throw new Error(`Cannot ${verb} a meeting that is already ${session.status}.`);
  }
}

function replaceSegment(
  session: MeetingCaptureSession,
  index: number,
  update: (segment: MeetingSegment) => MeetingSegment,
): MeetingCaptureSession {
  const segment = session.segments[index];
  if (!segment) throw new Error(`Meeting ${session.id} has no segment ${index}.`);
  if (isTerminalCaptureStatus(session.status)) {
    throw new Error(`Cannot transcribe a meeting that is already ${session.status}.`);
  }
  const next = update(segment);
  if (next === segment) return session;
  const segments = session.segments.slice();
  segments[index] = next;
  return { ...session, segments };
}
