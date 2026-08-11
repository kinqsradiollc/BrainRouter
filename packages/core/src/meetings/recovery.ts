/**
 * ADR-035 D2/D6 — what a host offers back after a crash.
 *
 * §6 judges this feature with a destructive test: kill the application
 * mid-recording, reopen it, and the meeting must be there. The part of that
 * which is not host-specific is the question "which of these persisted sessions
 * should I offer the user", and D2 answers it in one line — a session with audio
 * and no terminal state.
 *
 * Both halves matter. Without "has audio" a host offers back an empty session
 * created by a Record that was cancelled a second later, and the offer becomes
 * noise a user learns to dismiss. Without "no terminal state" it offers back a
 * meeting the user already finalized or explicitly threw away, which is worse
 * than noise — it is a product that will not let go of a recording someone asked
 * it to forget.
 *
 * ## The third clause, and why it is the CALLER's
 *
 * A recording in progress must not be offered back either — with a Delete
 * beside it, that is the loss this ADR exists to end. For one round this module
 * asked the record: a lease, with a heartbeat stamp a writer refreshed. It is
 * gone, because a stamp answers a different question from the one being asked.
 * "Is somebody recording into this?" is about a live process; a stamp is about a
 * moment that has already passed. An application killed one second ago leaves a
 * stamp that still looks fresh for the whole staleness window, so the meeting
 * §6's destructive test is about was withheld from the offer — on surfaces that
 * ask once and never ask again. The field intended to protect a live recording
 * was reliably hiding a dead one.
 *
 * The hosts can answer it exactly, and only they can: the desktop keeps a writer
 * map in the single process every window lives in, and the browser holds a Web
 * Lock per browsing context, released by the browser itself the moment the
 * context is gone. Neither survives a `kill -9`, which is the property a stamp
 * could not have. So the predicate here is the two record-shaped clauses, and
 * each host subtracts its own live captures at its own boundary — the desktop
 * through `supervisor.isWriting`, the dashboard through `resumableCaptures`'
 * `exclude`. Reintroducing a clause here that reads the record would be the
 * withheld-meeting defect again, and this time with no host left compensating
 * for it.
 */
import { capturedByteLength, isTerminalCaptureStatus, sameCaptureScope } from './captureSession.js';
import type { MeetingCaptureScope, MeetingCaptureSession } from './types.js';

export interface ResumableSessionOptions {
  /**
   * Open question 5 — only offer sessions from the org/workspace now in context.
   * A recording started under one org must not silently land in another, and the
   * offer is the moment that would happen. Omit to consider every scope.
   */
  readonly scope?: MeetingCaptureScope;
}

/**
 * D2 — audio present and no terminal state.
 *
 * Status is deliberately not narrowed to `recording`: a session stopped by a
 * clean quit still holds audio that never finished transcribing, and D7 says it
 * should drain when the endpoint returns. Recovery is about unfinished work, not
 * about how the process died.
 *
 * It takes no clock, and that is the point rather than an omission. Every
 * instant this answered differently at was an instant a killed writer's meeting
 * was being kept from the person looking for it. What survives a kill is the
 * record; the record now says only what the meeting IS, so this reads it and
 * needs to know nothing about when.
 */
export function isResumableSession(session: MeetingCaptureSession): boolean {
  if (isTerminalCaptureStatus(session.status)) return false;
  return capturedByteLength(session) > 0;
}

/** The recovery offer, newest first — the order a user reads it in. */
export function resumableSessions(
  sessions: readonly MeetingCaptureSession[],
  options: ResumableSessionOptions = {},
): readonly MeetingCaptureSession[] {
  const scope = options.scope;
  return sessions
    .filter((session) => isResumableSession(session))
    .filter((session) => !scope || sameCaptureScope(session.scope, scope))
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** What the offer says, so both hosts describe a recovered meeting the same way. */
export interface MeetingRecoverySummary {
  readonly sessionId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly byteLength: number;
  readonly segments: number;
  readonly settled: number;
  readonly gaps: number;
  readonly unsettled: number;
}

export function summarizeRecovery(session: MeetingCaptureSession): MeetingRecoverySummary {
  let settled = 0;
  let gaps = 0;
  let unsettled = 0;
  for (const segment of session.segments) {
    if (segment.state === 'done') settled += 1;
    else if (segment.state === 'failed') gaps += 1;
    else unsettled += 1;
  }
  const last = session.segments[session.segments.length - 1];
  return {
    sessionId: session.id,
    title: session.title,
    startedAt: session.startedAt,
    durationMs: last ? last.endMs : 0,
    byteLength: capturedByteLength(session),
    segments: session.segments.length,
    settled,
    gaps,
    unsettled,
  };
}

/**
 * D6 — capture stores with no session record, which the host reaps at boot.
 *
 * The pairing is by session id because D2 makes the id the directory name, so
 * "which directories are orphans" is a set difference and not a filesystem
 * question. Keeping it pure is what lets the desktop reap directories and the
 * dashboard reap OPFS folders with one rule.
 *
 * An orphan is audio NO session claims, so nothing in the record can protect it
 * — there is no record. The live-capture case is covered by the caller passing
 * every session it can read: a capture another window is recording has a record,
 * so it is not in this answer. Everything a reap decides on its own — a record
 * with no audio yet, a directory a `begin` has only half-written — must ask the
 * host which captures are live first, because those are exactly the shapes a
 * recording that started one second ago has.
 */
export function orphanCaptureIds(
  storedCaptureIds: readonly string[],
  sessions: readonly MeetingCaptureSession[],
): readonly string[] {
  const known = new Set(sessions.map((session) => session.id));
  return storedCaptureIds.filter((id) => !known.has(id));
}
