/**
 * ADR-035 D2/D6 — a capture that is being written to RIGHT NOW says so in its
 * own record, so every holder of the store gets the same answer.
 *
 * **The defect this exists to end, and why it kept coming back.** Liveness was
 * tracked beside the store instead of inside it. The desktop held it in
 * `hold.sessionId` / `captureInFlight(hold)` and the dashboard in
 * `captureRef.current` / `queueRef.current` — all four are React state in ONE
 * mount. The store is not: the desktop registers one `MeetingCaptureStore` per
 * PROCESS, and the browser's is scoped to the ORIGIN, not to the tab. So a
 * SECOND holder of the same store has an empty hold, every "is something
 * recording?" guard short-circuits false, and the live recording is offered back
 * as resumable with an enabled Delete beside it. Reachable without contrivance
 * on both hosts: `openWorkspaceWindow` mints a second desktop window over the
 * same store, and in the browser it is a second tab — or the SAME tab after
 * leaving /meetings and coming back, because there is no unmount teardown for a
 * live capture there at all.
 *
 * Every guard added for that in three rounds was a new copy of the same mistake
 * under a new name. **The fix is not another guard. It is to move the fact.** A
 * writer stamps its liveness into the record it is already persisting, and the
 * offer, the discard, the reap and the destructive guards all read it back from
 * there. A holder that has never heard of another holder still gets the right
 * answer, because the answer is not in either holder.
 *
 * **The shape is a lease with a heartbeat and a fencing epoch**, which is what
 * this repo already uses one layer down (ADR-029 B2/Q1, itself written after
 * migration `048_job_lease_fencing.sql`: *a lease without a fencing token is not
 * a lock*). Nothing here is a new idea; it is that idea applied to the one
 * record both hosts already write.
 *
 * Five invariants, each of which a caller could otherwise get wrong quietly:
 *
 * 1. **Freshness is computed from the record and NOTHING else.** No holder-local
 *    state, no "am I the one recording" flag, no process identity. Two holders
 *    reading the same bytes agree by construction — which is the whole point,
 *    and the property the four deleted guards could not have.
 * 2. **Expiry is the only mechanism that can be trusted.** §6 kills the
 *    application; a `kill -9` gets no chance to release anything. So a lease
 *    lapses because nobody renewed it, never because somebody tidied up.
 *    `releaseCaptureLease` exists to make a CLEAN stop offerable immediately —
 *    it is an optimisation, and nothing in this module is correct only when it
 *    is called.
 * 3. **The epoch outlives the term.** A release ends the term and keeps the
 *    count, because a fencing token that can be reset is not a fencing token:
 *    drop the record and the next acquisition mints epoch 1 again, matching the
 *    epoch a stalled writer is still carrying.
 * 4. **A heartbeat never revives an expired lease.** That is 048's one live
 *    leak — an unfenced renewal that keeps a lease looking healthy while the
 *    wrong process holds it up. Between expiry and the late heartbeat another
 *    holder may have taken the recording over; the correct move is to acquire
 *    again, which bumps the epoch and fences the writer that was gone.
 * 5. **Ambiguity resolves toward "someone is writing".** Inside the staleness
 *    window an unclear record is read as live, because the cost of being wrong
 *    that way is an offer that arrives late, and the cost of being wrong the
 *    other way is a meeting destroyed while it is being recorded. Outside the
 *    window the tie breaks the other way, so a capture can never be buried.
 *
 * **What this does NOT fence.** `appendSegment` and the transcription queue's
 * writes are deliberately not gated on a claim. A lease here is coordination
 * about a recording, not permission to record: gating the hot path would mean a
 * writer that missed a heartbeat stops being able to save audio, which is the
 * loss this ADR exists to prevent, arriving through the door meant to stop it.
 * A writer that loses its lease learns at its next heartbeat
 * (`stale_epoch` / `held_by_another`) and stops of its own accord.
 *
 * ## The clock, stated rather than assumed
 *
 * There is no monotonic option. `performance.now()` and `hrtime` are
 * process-local, and the entire requirement is that a DIFFERENT process (or tab)
 * can read this. So freshness is the difference between two readings of the same
 * machine's wall clock, and that buys three properties worth naming:
 *
 * - A clock that is simply WRONG — the wrong timezone, an hour out — cancels in
 *   the subtraction, because both readings come from it.
 * - A clock STEP between the writer's stamp and the reader's read is the only
 *   thing that moves the answer, and it is handled symmetrically: the lease is
 *   fresh while the stamp is within one staleness window of now IN EITHER
 *   DIRECTION. A backward step makes a live writer's stamp look like the future;
 *   honouring the future without limit would let a stamp from a clock set months
 *   ahead bury a crashed meeting for months, so the window is bounded on both
 *   sides.
 * - The residue, stated because it is real: a backward step LARGER than the
 *   staleness window makes a live recording look abandoned until its next
 *   heartbeat — at most `MEETING_CAPTURE_HEARTBEAT_MS`, after which the writer's
 *   own stamp corrects it. Every failure here self-heals within one heartbeat as
 *   long as the writer is alive; only a dead writer's record stays where the
 *   clock left it, and a dead writer's record is exactly what should be offered
 *   back.
 *
 * A stamp we cannot parse at all is STALE, not fresh — invariant 5 applies
 * inside the window, and an unreadable stamp is not inside anything. A live
 * writer would have overwritten it within one heartbeat, so "unreadable" means
 * nobody is writing; treating it as live would make that capture unrecoverable
 * for ever, with nothing left to correct it.
 */
import type { MeetingCaptureLease, MeetingCaptureSession, MeetingCaptureStatus } from './types.js';

/**
 * How often a writer says it is still here.
 *
 * Five seconds is chosen against the two things that actually miss a beat. A
 * main-thread stall (GC, a synchronous render, a modal) is well under it. A
 * BACKGROUND browser tab is not: timers there are clamped, and a recording tab
 * that the user has switched away from is precisely the second-holder case this
 * module exists for. That is why a heartbeat is also required on every durable
 * write — `ondataavailable` comes from the media stack rather than from a timer,
 * so a throttled tab still stamps its record on the chunk cadence.
 */
export const MEETING_CAPTURE_HEARTBEAT_MS = 5_000;

/**
 * How long after the last heartbeat a capture is treated as abandoned.
 *
 * Deliberately chosen between two failures that pull in opposite directions,
 * because both are losses:
 *
 * - **Too short** and a live meeting looks dead. Six missed heartbeats is the
 *   floor here, and the binding constraint is not the timer but the chunk
 *   cadence: in a throttled background tab the only reliable heartbeat is the
 *   one riding `ondataavailable`, so the threshold must clear
 *   `DEFAULT_MEETING_SEGMENT_MS` (20s) with margin. Thirty seconds is 1.5× it.
 *   Anything under twenty would mark every backgrounded recording abandoned —
 *   the defect, reintroduced by a constant. (When D9 splits the durability chunk
 *   down to 2–5s, that margin only grows.)
 * - **Too long** and §6's destructive test stops passing: after a kill the
 *   meeting is not offered back until the lease lapses. Thirty seconds is
 *   comfortably inside the time it takes a person to relaunch a killed app and
 *   reach the meetings surface, and `captureLeaseStaleAt` lets a surface say
 *   when it will appear instead of showing nothing (ADR-028).
 *
 * A boot-time blanket clear would remove that second cost, and is deliberately
 * NOT offered: it would only be sound for a host that can prove no other writer
 * of this store exists, and neither host can — the desktop takes no
 * single-instance lock, and the browser cannot see its other tabs.
 */
export const MEETING_CAPTURE_LEASE_STALE_MS = 30_000;

/** What a holder presents when it takes a recording over. */
export interface MeetingCaptureLeaseRequest {
  /** Identifies the WRITER — one per window/tab, not one per process or origin. */
  readonly holderId: string;
  /** What a surface calls it: "another window", "another tab". Optional; there is a generic fallback. */
  readonly holder?: string;
}

/** What a writer believes it holds. Both halves are checked; neither is optional. */
export interface MeetingCaptureLeaseClaim {
  readonly holderId: string;
  readonly epoch: number;
}

export type CaptureLeaseRefusal =
  /** Another holder's lease is still fresh. */
  | 'held_by_another'
  /** The lease was re-acquired since this claim was made — this writer was fenced out. */
  | 'stale_epoch'
  /** The term ran out. Acquire again rather than renewing (invariant 4). */
  | 'lease_expired'
  /** There is no lease to renew or release. */
  | 'not_held'
  /** The capture is finalized or discarded; nothing may write to it again. */
  | 'capture_closed';

export type CaptureLeaseOutcome =
  | { readonly ok: true; readonly session: MeetingCaptureSession; readonly lease: MeetingCaptureLease }
  | {
    readonly ok: false;
    readonly reason: CaptureLeaseRefusal;
    readonly detail: string;
    /** The lease that refused, when there is one to show a user. */
    readonly holder?: MeetingCaptureLease;
  };

/**
 * A holder id for one window or tab.
 *
 * Same fallback as `newMeetingSessionId` and for the same reason:
 * `crypto.randomUUID` is unavailable outside a secure context and the dashboard
 * is not always served from one, so a plain-http origin must still be able to
 * identify its writer.
 */
export function newCaptureHolderId(): string {
  const webcrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webcrypto?.randomUUID === 'function') return `wr-${webcrypto.randomUUID()}`;
  return `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The one rule. Everything else in this module — and every call site in both
 * hosts — is this question asked at a different moment.
 */
export function isCaptureLeaseFresh(
  lease: MeetingCaptureLease | undefined,
  at: string = new Date().toISOString(),
): lease is MeetingCaptureLease {
  const stored = storedLease(lease);
  if (!stored) return false;
  const heartbeat = Date.parse(stored.heartbeatAt);
  const now = Date.parse(at);
  if (!Number.isFinite(heartbeat) || !Number.isFinite(now)) return false;
  // Symmetric on purpose — see the clock note in the module header. A stamp in
  // the future is a backward clock step, not a forgery, and it is honoured only
  // as far as a stamp in the past would be.
  return Math.abs(now - heartbeat) < MEETING_CAPTURE_LEASE_STALE_MS;
}

/** The writer of this capture, if one is writing to it right now. */
export function liveCaptureWriter(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): MeetingCaptureLease | undefined {
  const lease = storedLease(session.writer);
  return isCaptureLeaseFresh(lease, at) ? lease : undefined;
}

/**
 * D6 — is somebody recording into this capture at this instant?
 *
 * The predicate the offer, the discard, the reap and the Create guard all ask.
 * A capture this answers `true` for is not offered as resumable, is not
 * discardable and is not reapable, by ANY holder including the one asking.
 */
export function isCaptureBeingWritten(
  session: MeetingCaptureSession,
  at: string = new Date().toISOString(),
): boolean {
  return liveCaptureWriter(session, at) !== undefined;
}

/**
 * The live recordings in a set — what a reap keeps and what a Create guard
 * refuses over.
 *
 * A host with a per-process or per-origin store cannot answer this from its own
 * memory, which is the whole reason this module exists; it reads the records it
 * already has.
 */
export function capturesBeingWritten(
  sessions: readonly MeetingCaptureSession[],
  at: string = new Date().toISOString(),
): readonly MeetingCaptureSession[] {
  return sessions.filter((session) => isCaptureBeingWritten(session, at));
}

/**
 * When this lease lapses, so a surface can say "available in 12s" and schedule
 * one refresh instead of showing nothing and hoping the user tries again
 * (ADR-028: the surface says which state it is in).
 */
export function captureLeaseStaleAt(lease: MeetingCaptureLease | undefined): string | undefined {
  const stored = storedLease(lease);
  if (!stored) return undefined;
  const heartbeat = Date.parse(stored.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return undefined;
  return new Date(heartbeat + MEETING_CAPTURE_LEASE_STALE_MS).toISOString();
}

/**
 * What a surface says instead of offering a live recording back, or `null` when
 * there is nothing to say.
 *
 * `null` when the viewer IS the writer, for the same reason `describeBlockLease`
 * does it: a panel that tells you that you are recording is noise on the surface
 * you are recording from. Omitting `viewerHolderId` asks the question with no
 * viewer at all, which is what a destructive guard wants — a caller that cannot
 * name itself is not the writer.
 */
export function describeCaptureWriter(
  session: MeetingCaptureSession,
  viewerHolderId?: string,
  at: string = new Date().toISOString(),
): string | null {
  const writer = liveCaptureWriter(session, at);
  if (!writer) return null;
  if (viewerHolderId !== undefined && writer.holderId === viewerHolderId) return null;
  return `${label(writer)} is recording this meeting right now.`;
}

/**
 * Take the recording over, or say who has it.
 *
 * Acquisition — and only acquisition — issues a new epoch, exactly as ADR-029's
 * block lease and 048's claim do: any writer still carrying the previous epoch
 * is fenced out from this moment, which is what makes reclaiming an abandoned
 * lease safe. A holder re-acquiring its OWN lease bumps it too, because the case
 * that matters there is a tab that reloaded: the page is new, its queued writes
 * are gone, and the epoch it was carrying should stop being honoured.
 */
export function acquireCaptureLease(
  session: MeetingCaptureSession,
  request: MeetingCaptureLeaseRequest,
  at: string = new Date().toISOString(),
): CaptureLeaseOutcome {
  if (!acceptsWrites(session.status)) {
    return {
      ok: false,
      reason: 'capture_closed',
      detail: `This meeting is already ${session.status}; nothing more can be recorded into it.`,
    };
  }
  const current = storedLease(session.writer);
  if (isCaptureLeaseFresh(current, at) && current.holderId !== request.holderId) {
    return {
      ok: false,
      reason: 'held_by_another',
      detail: `${label(current)} is recording this meeting right now.`,
      holder: current,
    };
  }
  const lease: MeetingCaptureLease = {
    holderId: request.holderId,
    ...(request.holder ? { holder: request.holder } : {}),
    // A record we could not read cannot fence anything, so its count is not
    // carried forward — there is nothing left in it to be stale against.
    epoch: (current?.epoch ?? 0) + 1,
    heartbeatAt: at,
  };
  return { ok: true, session: { ...session, writer: lease }, lease };
}

/**
 * Still here. The term extends; the epoch does not move.
 *
 * An EXPIRED lease is refused even to the holder that had it and even with the
 * right epoch (invariant 4). Between the expiry and this call another holder may
 * have taken the recording over, and quietly extending would re-establish a
 * claim over a capture this writer no longer owns — 048's leaked unfenced
 * heartbeat, one layer up. Acquire instead: it bumps the epoch, which is the
 * point.
 */
export function heartbeatCaptureLease(
  session: MeetingCaptureSession,
  claim: MeetingCaptureLeaseClaim,
  at: string = new Date().toISOString(),
): CaptureLeaseOutcome {
  const refusal = checkClaim(session, claim);
  if (refusal) return refusal;
  const current = storedLease(session.writer)!;
  if (!isCaptureLeaseFresh(current, at)) {
    return {
      ok: false,
      reason: 'lease_expired',
      detail: 'This recording’s lease lapsed. Acquire it again before writing more audio.',
      holder: current,
    };
  }
  const lease: MeetingCaptureLease = { ...current, heartbeatAt: at };
  return { ok: true, session: { ...session, writer: lease }, lease };
}

/**
 * Hand the recording back, so a cleanly stopped capture is offered again at once
 * instead of after the staleness window.
 *
 * The record is kept with its term ended rather than removed, because the epoch
 * has to outlive it (invariant 3). Nothing in this module is correct only when
 * this is called — a killed writer never gets here, and expiry covers it.
 */
export function releaseCaptureLease(
  session: MeetingCaptureSession,
  claim: MeetingCaptureLeaseClaim,
  at: string = new Date().toISOString(),
): CaptureLeaseOutcome {
  const refusal = checkClaim(session, claim);
  if (refusal) return refusal;
  const current = storedLease(session.writer)!;
  const lease: MeetingCaptureLease = { ...current, heartbeatAt: endedAt(at) };
  return { ok: true, session: { ...session, writer: lease }, lease };
}

/**
 * The stamp that reads as "nobody is writing" from any clock: exactly one
 * staleness window in the past, which the symmetric freshness test refuses at
 * the boundary and further refuses as time passes.
 */
function endedAt(at: string): string {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) return at;
  return new Date(now - MEETING_CAPTURE_LEASE_STALE_MS).toISOString();
}

/** The three refusals a renewal and a release share, in the order they are asked. */
function checkClaim(
  session: MeetingCaptureSession,
  claim: MeetingCaptureLeaseClaim,
): Extract<CaptureLeaseOutcome, { ok: false }> | null {
  if (!acceptsWrites(session.status)) {
    return {
      ok: false,
      reason: 'capture_closed',
      detail: `This meeting is already ${session.status}; its lease means nothing now.`,
    };
  }
  const current = storedLease(session.writer);
  if (!current) {
    return { ok: false, reason: 'not_held', detail: 'No writer holds this recording.' };
  }
  if (current.holderId !== claim.holderId) {
    return {
      ok: false,
      reason: 'held_by_another',
      detail: `${label(current)} holds this recording now.`,
      holder: current,
    };
  }
  if (current.epoch !== claim.epoch) {
    return {
      ok: false,
      reason: 'stale_epoch',
      detail: 'This recording’s lease was reissued — stop writing and acquire it again.',
      holder: current,
    };
  }
  return null;
}

/**
 * A lease as read back out of a record, or `undefined` when it is not one.
 *
 * The record is JSON that a previous build (or a half-written flush) may have
 * produced, so every field is checked. Nothing here is about an attacker: the
 * desktop's capture directory is `0700` and OPFS is origin-scoped. It is about
 * our own past selves, and about invariant 5's outer half — a lease we cannot
 * read is not a lease, and a capture must never be held hostage by one.
 */
function storedLease(lease: MeetingCaptureLease | undefined): MeetingCaptureLease | undefined {
  if (!lease || typeof lease !== 'object') return undefined;
  if (typeof lease.holderId !== 'string' || !lease.holderId) return undefined;
  if (!Number.isInteger(lease.epoch) || lease.epoch <= 0) return undefined;
  // The stamp is checked for being a string and nothing more: every caller
  // parses it, and an empty or malformed one fails that parse. A second,
  // narrower check here would be a line no test could ever distinguish.
  if (typeof lease.heartbeatAt !== 'string') return undefined;
  return lease;
}

function label(lease: MeetingCaptureLease): string {
  return lease.holder?.trim() || 'Another window';
}

/**
 * Terminality, decided here rather than imported.
 *
 * `captureSession.ts` has `isTerminalCaptureStatus`, and it needs THIS module
 * for its destructive guards — importing it back would put a cycle between the
 * two files that matter most in this subsystem. An exhaustive switch is not a
 * silent second copy of the rule: adding a status to the union leaves this
 * function without a return on that path, which is a compile error under
 * `strict`, so the next person is forced to answer the question here too.
 */
function acceptsWrites(status: MeetingCaptureStatus): boolean {
  switch (status) {
    case 'recording':
    case 'stopped':
      return true;
    case 'finalized':
    case 'discarded':
      return false;
  }
}
