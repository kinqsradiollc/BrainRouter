/**
 * ADR-035 D3/D5/D7 — the segment transcription queue: the thing that actually
 * drives a meeting from "bytes on disk" to "text in the transcript".
 *
 * D1 wrote the audio down; D3 says the unit of transcription is a segment. What
 * was missing between them was a driver — something that picks the next segment,
 * spends an attempt, applies the result to the session, and knows when to stop.
 * Without it the retry policy and the transcript selector are rules nothing
 * obeys, which is a more expensive kind of nothing than not having written them.
 *
 * Everything host-specific is a port. The queue never touches a filesystem, an
 * OPFS handle, `fetch`, or a timer, so the desktop and the dashboard run the
 * SAME scheduler over the same session model (D1b) and differ only in where the
 * bytes come from and where the record goes.
 *
 * Four properties this module exists to guarantee, each of which is a way a
 * naive loop loses a meeting:
 *
 * 1. **Bounded concurrency.** A one-hour meeting is ~180 segments. Firing 180
 *    requests at the STT sidecar the moment the network returns is a denial of
 *    service against our own backend, and the sidecar answering none of them
 *    looks exactly like a meeting that failed. At most `maxInFlight` (default 2)
 *    are ever outstanding.
 * 2. **An outage costs no retry budget — but not for ever.** D7. See
 *    `requeueSegment` — a failure to reach the endpoint is a verdict on the
 *    server, not on the audio, and if it counted, a few minutes of a dead
 *    sidecar would permanently mark a good meeting as gaps. The refund is
 *    nevertheless BOUNDED (`deferralsExhausted`), because the queue does not
 *    get to assume the answer it was handed is honest: an endpoint that reports
 *    "try again later" for audio that will never decode would otherwise hold
 *    the segment at `attempts: 0` and re-upload the same bytes for ever, with
 *    the transcript cheerfully reporting it as still in progress. D7 says an
 *    outage must not consume the budget; it does not say a segment may be
 *    retried without limit.
 * 3. **Restartable.** The queue holds no work list. The next thing to do is
 *    computed from the persisted session every pass (`planTranscription`), so a
 *    host that constructs a queue over a recovered session at launch resumes
 *    exactly the segments that were unfinished — no more, no fewer.
 * 4. **Nothing disappears.** A segment that spends its budget becomes a stated
 *    gap in the transcript (`transcriptGaps`), never dropped.
 *
 * The queue is the SINGLE WRITER of the session while it exists: one queue per
 * meeting, and the host mutates the session through `apply` rather than beside
 * it. Two writers would interleave a `markDone` with an `appendChunk`/unit seal
 * and one of them would be lost — which is the same class of defect as losing
 * the audio, just quieter.
 */
import {
  markDone,
  markFailed,
  markTranscribing,
  requeueSegment,
  MEETING_ENDPOINT_UNRESPONSIVE_REASON,
  MEETING_INTERRUPTED_REASON,
} from './captureSession.js';
import { planTranscription, type MeetingQueuePlan } from './queuePlan.js';
import {
  DEFAULT_MEETING_RETRY_POLICY,
  deferralsExhausted,
  retryDelayMs,
  type MeetingRetryPolicy,
} from './retryPolicy.js';
import type { MeetingCaptureSession } from './types.js';

/** What both hosts' `MediaRecorder` produces unless it negotiated something else. */
export const DEFAULT_MEETING_AUDIO_MIME = 'audio/webm';

/** At most two requests outstanding: enough to hide latency, far short of a stampede. */
export const DEFAULT_MEETING_MAX_IN_FLIGHT = 2;

/**
 * The only things the queue asks a host for.
 *
 * `readSegment` reads back what D1 already wrote — a `0700` capture file on the
 * desktop, an OPFS blob in the dashboard. `persist` takes the WHOLE session,
 * which is deliberate: a persist that fails is subsumed by the next one that
 * succeeds, so a transient write error degrades to a late write rather than to a
 * hole in the record.
 */
export interface MeetingTranscriptionPorts {
  readSegment(index: number): Promise<Uint8Array> | Uint8Array;
  transcribe(audio: Uint8Array, mimeType: string): Promise<string> | string;
  persist(session: MeetingCaptureSession): Promise<void> | void;
  /** Epoch milliseconds. Injected so the backoff schedule is testable at an exact instant. */
  now?(): number;
}

/**
 * D7's distinction, and the most consequential type in this file.
 *
 * `segment` — the attempt happened and this audio did not transcribe (a 400, a
 * corrupt file, a body too large). It counts against the bound and ends as a
 * stated gap. `endpoint-unavailable` — the request never got an answer, so no
 * attempt on the audio occurred. It does not count.
 */
export type MeetingTranscriptionFailureKind = 'segment' | 'endpoint-unavailable';

/** Throw this from `transcribe` when the host already knows the endpoint is down. */
export class MeetingEndpointUnavailableError extends Error {
  /** Structural marker, so a host can signal an outage without importing this class. */
  readonly endpointUnavailable = true;
  constructor(message = 'The transcription endpoint did not answer.') {
    super(message);
    this.name = 'MeetingEndpointUnavailableError';
  }
}

/** Transport-level codes that mean the request never reached a server that could answer. */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Statuses that mean "not now" rather than "not this audio".
 *
 * 408/429/502/503/504 are the endpoint declining to serve; the same bytes will
 * transcribe fine once it recovers. Every other status — 400, 413, 415, 422,
 * even a 500 raised while decoding — is about this request, so it counts.
 * Being conservative here is the safe direction: mistaking a real failure for an
 * outage only delays a gap, while mistaking an outage for a real failure
 * destroys the budget that would have recovered the meeting.
 */
const UNAVAILABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * The default reading of a thrown error. A host with better information (it can
 * see the response) may pass its own `classifyFailure`.
 */
export function classifyTranscriptionFailure(error: unknown): MeetingTranscriptionFailureKind {
  if (!error || typeof error !== 'object') return 'segment';
  const candidate = error as {
    endpointUnavailable?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (candidate.endpointUnavailable === true) return 'endpoint-unavailable';
  if (typeof candidate.code === 'string' && UNAVAILABLE_CODES.has(candidate.code)) {
    return 'endpoint-unavailable';
  }
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status === 'number' && UNAVAILABLE_STATUSES.has(status)) return 'endpoint-unavailable';
  // The browser's only signal for "the request never got a response" is a bare
  // TypeError from fetch. Matching on it is unlovely, but the dashboard has to
  // be able to tell an outage from a rejected upload or D7 does not hold there.
  if (candidate.name === 'TypeError' && typeof candidate.message === 'string' && /fetch/i.test(candidate.message)) {
    return 'endpoint-unavailable';
  }
  if (candidate.cause && candidate.cause !== error) return classifyTranscriptionFailure(candidate.cause);
  return 'segment';
}

export interface MeetingTranscriptionQueueOptions {
  /** The persisted session, freshly loaded at launch or newly created at Record. */
  readonly session: MeetingCaptureSession;
  readonly ports: MeetingTranscriptionPorts;
  readonly maxInFlight?: number;
  readonly policy?: MeetingRetryPolicy;
  /** What the recorder actually produced; the endpoint needs it to decode. */
  readonly mimeType?: string;
  readonly classifyFailure?: (error: unknown) => MeetingTranscriptionFailureKind;
}

/**
 * Why a drain stopped, which is what tells the host when to come back.
 *
 * `unavailable` is D7's waiting state: work remains, no budget was spent, and
 * the endpoint should be probed again in `nextWakeMs`.
 */
export type MeetingDrainPhase = 'idle' | 'waiting' | 'unavailable' | 'closed';

export interface MeetingDrainResult {
  readonly session: MeetingCaptureSession;
  readonly phase: MeetingDrainPhase;
  /** Segments that settled during this drain. */
  readonly transcribed: readonly number[];
  /** Segments that made a real, failed attempt during this drain. */
  readonly failed: readonly number[];
  /** Segments returned to the queue by an outage — attempted, not charged. */
  readonly deferred: readonly number[];
  // There is deliberately no `gaps` here. The transcript already answers that
  // question — `transcriptGaps(result.session)` — and a second copy computed on
  // every drain was one both hosts ignored in favour of re-deriving it from
  // `transcriptSoFar`. A result field nobody reads is a maintenance cost that
  // looks like a feature.
  /**
   * Problems that belong to no segment — a `persist` that threw. Reported rather
   * than swallowed: a host whose writes are failing is a host about to lose a
   * meeting, and that is worth saying out loud.
   */
  readonly errors: readonly string[];
  /** Milliseconds until it is worth draining again, or `null` if only new work will change anything. */
  readonly nextWakeMs: number | null;
}

interface DrainOutcome {
  readonly transcribed: number[];
  readonly failed: number[];
  readonly deferred: number[];
  readonly errors: string[];
}

/**
 * The scheduler. One per meeting, constructed over the persisted session.
 *
 * Typical host wiring:
 *
 * ```ts
 * const queue = createMeetingTranscriptionQueue({ session, ports });
 * // a durability chunk landed on disk; grouping it into transcription work is
 * // a separate policy decision:
 * await queue.apply((s) => sealDueUnits(appendChunk(s, { byteLength, durationMs })));
 * const result = await queue.drain();
 * if (result.nextWakeMs !== null) scheduleAnotherDrain(result.nextWakeMs);
 * ```
 */
export class MeetingTranscriptionQueue {
  #session: MeetingCaptureSession;
  readonly #ports: MeetingTranscriptionPorts;
  readonly #maxInFlight: number;
  readonly #policy: MeetingRetryPolicy;
  readonly #mimeType: string;
  readonly #classify: (error: unknown) => MeetingTranscriptionFailureKind;

  /**
   * Dispatched by THIS queue, right now. Concurrency is counted from here rather
   * than from the session, because a segment is already in flight for the moment
   * between dispatch and its `transcribing` write landing — counting the record
   * would let the bound be exceeded in exactly that window.
   */
  readonly #inFlight = new Map<number, Promise<void>>();
  /** Indices this drain could not even record an attempt for; skipped so the loop terminates. */
  readonly #blocked = new Set<number>();
  #active: Promise<MeetingDrainResult> | null = null;
  #rerun = false;
  #reconciled = false;
  /** Consecutive outages, feeding the same backoff curve segments use. Not persisted: it is about the server. */
  #outageStreak = 0;
  #probeNotBeforeMs = 0;
  #unavailable = false;
  /** Serializes every write so two transitions cannot persist out of order. */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(options: MeetingTranscriptionQueueOptions) {
    this.#session = options.session;
    this.#ports = options.ports;
    this.#maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? DEFAULT_MEETING_MAX_IN_FLIGHT));
    this.#policy = options.policy ?? DEFAULT_MEETING_RETRY_POLICY;
    this.#mimeType = options.mimeType ?? DEFAULT_MEETING_AUDIO_MIME;
    this.#classify = options.classifyFailure ?? classifyTranscriptionFailure;
  }

  /** The session as the queue currently holds it — the same value it last persisted. */
  get session(): MeetingCaptureSession {
    return this.#session;
  }

  /**
   * The queue's own scheduling question, answered from the persisted session.
   *
   * Production machinery, run several times per drain: `#loop` dispatches from
   * `#plan().ready` and `#finish` derives `MeetingDrainResult.phase` from
   * `#plan().phase`.
   *
   * It is PRIVATE. It was public on the argument that a surface wanting to say
   * more than the drain's phase should read this answer rather than derive a
   * second opinion — but no surface does, and the desktop reaches for the free
   * function `planTranscription` when it needs the same picture. An exported
   * method with no caller outside its own class is a maintenance cost wearing
   * the costume of an extension point; `planTranscription` is already exported
   * and is the honest way in.
   */
  #plan(): MeetingQueuePlan {
    return planTranscription(this.#session, { policy: this.#policy, nowMs: this.#nowMs() });
  }

  /**
   * Apply a capture transition and persist the result.
   *
   * This is how a host appends a segment, stops, resumes, finalizes or discards
   * while a queue exists — through the single writer rather than beside it. Any
   * function from `captureSession.ts` fits.
   */
  async apply(
    transition: (session: MeetingCaptureSession) => MeetingCaptureSession,
  ): Promise<MeetingCaptureSession> {
    await this.#commit(transition);
    return this.#session;
  }

  /**
   * Transcribe everything that is due, then report why it stopped.
   *
   * Concurrent calls join the running drain rather than starting a second one —
   * two loops would both dispatch the same ready segment. The running loop
   * re-plans every pass, so a segment appended while it runs is still picked up.
   */
  async drain(): Promise<MeetingDrainResult> {
    if (this.#active) {
      this.#rerun = true;
      const joined = await this.#active;
      // The running loop clears `#rerun` each time it re-plans. Still set means it
      // finished without ever seeing the work this call is about, so joining its
      // answer would report "idle" over a segment nobody has looked at.
      if (!this.#rerun) return joined;
    }
    while (this.#active) await this.#active.catch(() => undefined);
    return this.#begin();
  }

  /**
   * D5's retry affordance: a person asked for this gap again.
   *
   * It bypasses the backoff AND the exhausted verdict, because the bound exists
   * to stop an automatic loop, not to overrule someone who can see the meeting.
   * It is still one attempt, not a reset — a segment that was exhausted is
   * exhausted again the moment this attempt fails.
   */
  async retry(index: number): Promise<MeetingDrainResult> {
    while (this.#active) {
      await this.#active.catch(() => undefined);
    }
    return this.#begin(index);
  }

  #begin(force?: number): Promise<MeetingDrainResult> {
    const active = this.#loop(force).finally(() => {
      this.#active = null;
    });
    this.#active = active;
    return active;
  }

  async #loop(force?: number): Promise<MeetingDrainResult> {
    const outcome: DrainOutcome = { transcribed: [], failed: [], deferred: [], errors: [] };
    this.#blocked.clear();

    if (this.#plan().phase === 'closed') return this.#result('closed', outcome, null);

    // D7 — respect our own cooldown. A host that re-drains on a timer during an
    // outage would otherwise hammer a sidecar that is already struggling; the
    // whole point of the queue is that it never does that. A person-initiated
    // retry is exempt: they are watching, and one request is not a stampede.
    const nowMs = this.#nowMs();
    if (force === undefined && this.#outageStreak > 0 && nowMs < this.#probeNotBeforeMs) {
      return this.#result('unavailable', outcome, this.#probeNotBeforeMs - nowMs);
    }
    this.#unavailable = false;

    await this.#reconcile(outcome);
    if (force !== undefined) {
      // A settled segment has nothing to retry, and one already in flight is
      // being retried. Either way, forcing it would only manufacture an error.
      const segment = this.#session.segments[force];
      if (segment && segment.state !== 'done' && segment.state !== 'transcribing') {
        this.#dispatch(force, outcome);
      }
    }

    for (;;) {
      // Cleared before planning, so anything a concurrent `drain()` added up to
      // this instant is inside the plan we are about to compute.
      this.#rerun = false;
      if (!this.#unavailable) {
        const plan = this.#plan();
        if (plan.phase === 'closed') break;
        for (const index of plan.ready) {
          if (this.#inFlight.size >= this.#maxInFlight) break;
          if (this.#inFlight.has(index) || this.#blocked.has(index)) continue;
          this.#dispatch(index, outcome);
        }
      }
      if (!this.#inFlight.size) break;
      await Promise.race(this.#inFlight.values());
    }
    if (this.#inFlight.size) await Promise.all([...this.#inFlight.values()]);

    return this.#finish(outcome);
  }

  #finish(outcome: DrainOutcome): MeetingDrainResult {
    const plan = this.#plan();
    if (plan.phase === 'closed') return this.#result('closed', outcome, null);
    if (this.#unavailable) {
      return this.#result('unavailable', outcome, Math.max(0, this.#probeNotBeforeMs - this.#nowMs()));
    }
    if (plan.phase === 'waiting') return this.#result('waiting', outcome, plan.nextWakeMs);
    // `working` here means we stopped with work still ready — only possible when
    // a write failed and blocked the segment. Say "come back", not "idle".
    if (plan.phase === 'working') return this.#result('waiting', outcome, plan.nextWakeMs ?? 0);
    return this.#result('idle', outcome, null);
  }

  #result(phase: MeetingDrainPhase, outcome: DrainOutcome, nextWakeMs: number | null): MeetingDrainResult {
    return {
      session: this.#session,
      phase,
      transcribed: outcome.transcribed,
      failed: outcome.failed,
      deferred: outcome.deferred,
      errors: outcome.errors,
      nextWakeMs,
    };
  }

  /**
   * A segment that says `transcribing` but that this queue never dispatched
   * belongs to a process that died mid-attempt (§6's destructive test). It is
   * corrected exactly as `recoverCaptureSession` corrects it — failed, with its
   * spent attempt kept — because "Transcribing…" on an attempt whose process is
   * gone is the lie ADR-028 asks the surface not to tell. Run once: after that,
   * the queue is the only thing that puts a segment into flight.
   */
  async #reconcile(outcome: DrainOutcome): Promise<void> {
    if (this.#reconciled) return;
    this.#reconciled = true;
    const orphans = this.#session.segments
      .filter((segment) => segment.state === 'transcribing')
      .map((segment) => segment.index);
    for (const index of orphans) {
      await this.#commitSafely(
        (session) => markFailed(session, index, MEETING_INTERRUPTED_REASON, this.#stamp()),
        outcome,
      );
    }
  }

  #dispatch(index: number, outcome: DrainOutcome): void {
    if (this.#inFlight.has(index)) return;
    const run = this.#attempt(index, outcome).finally(() => {
      this.#inFlight.delete(index);
    });
    this.#inFlight.set(index, run);
  }

  /** One attempt at one segment. Never rejects — a rejected member would abort the drain. */
  async #attempt(index: number, outcome: DrainOutcome): Promise<void> {
    // Read the reason BEFORE announcing the attempt: `markTranscribing` clears
    // it, and D7's give-back needs it back if this turns out to be an outage.
    const previousFailureReason = this.#session.segments[index]?.failureReason;
    try {
      await this.#commit((session) => markTranscribing(session, index, this.#stamp()));
    } catch (error) {
      // The attempt could not even be recorded, so nothing was sent. Blocking the
      // index is what keeps the loop from re-dispatching it forever.
      this.#blocked.add(index);
      outcome.errors.push(describeFailure(error));
      return;
    }
    let audio: Uint8Array;
    try {
      audio = await this.#ports.readSegment(index);
    } catch (error) {
      // Unreadable audio is a fact about this segment, not about the endpoint:
      // it counts, and it ends as a stated gap rather than as a retry forever.
      await this.#failSegment(index, error, outcome);
      return;
    }
    try {
      const text = await this.#ports.transcribe(audio, this.#mimeType);
      this.#outageStreak = 0;
      await this.#commitSafely((session) => markDone(session, index, text), outcome);
      outcome.transcribed.push(index);
    } catch (error) {
      if (this.#classify(error) === 'endpoint-unavailable') {
        // The cooldown is owed either way: whatever we decide about this
        // segment's budget, the endpoint just told us it cannot serve, and
        // re-probing it immediately is the stampede this queue exists to avoid.
        this.#unavailable = true;
        this.#outageStreak += 1;
        this.#probeNotBeforeMs = this.#nowMs() + retryDelayMs(this.#outageStreak, this.#policy);
        const segment = this.#session.segments[index];
        if (segment && !deferralsExhausted(segment, { policy: this.#policy })) {
          await this.#commitSafely(
            (session) => requeueSegment(session, index, previousFailureReason, this.#stamp()),
            outcome,
          );
          outcome.deferred.push(index);
          return;
        }
        // Refunds spent. From here an outage costs an attempt like anything
        // else, so the ordinary D5 bound closes this out: the segment either
        // transcribes when the endpoint genuinely returns, or becomes a stated
        // gap a person can see and retry. What it can no longer do is sit at
        // `attempts: 0` re-uploading the same bytes while the transcript claims
        // it is still coming — which is what a caller that reports every failure
        // as an outage would otherwise buy us.
        await this.#commitSafely(
          (session) => markFailed(session, index, MEETING_ENDPOINT_UNRESPONSIVE_REASON, this.#stamp()),
          outcome,
        );
        outcome.failed.push(index);
        return;
      }
      await this.#failSegment(index, error, outcome);
    }
  }

  async #failSegment(index: number, error: unknown, outcome: DrainOutcome): Promise<void> {
    await this.#commitSafely(
      (session) => markFailed(session, index, describeFailure(error), this.#stamp()),
      outcome,
    );
    outcome.failed.push(index);
  }

  /**
   * Apply a transition and write the result down, serialized against every other
   * write so persists cannot land out of order.
   *
   * The in-memory session is NOT rolled back when `persist` throws. `persist`
   * takes the whole session, so the next successful write carries this
   * transition too; discarding a `done` with real text because one write failed
   * would throw away work that already cost a round trip.
   */
  async #commit(transition: (session: MeetingCaptureSession) => MeetingCaptureSession): Promise<void> {
    const write = this.#writes.then(async () => {
      this.#session = transition(this.#session);
      await this.#ports.persist(this.#session);
    });
    this.#writes = write.catch(() => undefined); // one failed write must not poison the chain
    await write;
  }

  async #commitSafely(
    transition: (session: MeetingCaptureSession) => MeetingCaptureSession,
    outcome: DrainOutcome,
  ): Promise<void> {
    try {
      await this.#commit(transition);
    } catch (error) {
      outcome.errors.push(describeFailure(error));
    }
  }

  #nowMs(): number {
    return this.#ports.now?.() ?? Date.now();
  }

  #stamp(): string {
    return new Date(this.#nowMs()).toISOString();
  }
}

export function createMeetingTranscriptionQueue(
  options: MeetingTranscriptionQueueOptions,
): MeetingTranscriptionQueue {
  return new MeetingTranscriptionQueue(options);
}

/**
 * The failure in words a user can act on (D5), bounded in length.
 *
 * The cap is not cosmetic: this string is persisted with the session on every
 * write, and an endpoint that answers a failed upload with an HTML error page
 * would otherwise put a kilobyte of markup into the meeting record forever.
 */
const MAX_FAILURE_REASON_LENGTH = 240;

function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return 'Transcription failed.';
  return text.length > MAX_FAILURE_REASON_LENGTH ? `${text.slice(0, MAX_FAILURE_REASON_LENGTH - 1)}…` : text;
}
