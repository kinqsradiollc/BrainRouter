/**
 * ADR-035 D2/D6 — what a host offers back after a crash.
 *
 * §6 judges this feature with a destructive test: kill the application
 * mid-recording, reopen it, and the meeting must be there. The part of that
 * which is not host-specific is the question "which of these persisted sessions
 * should I offer the user", and D2 answers it in one line — a session with audio
 * and no terminal state.
 *
 * Both halves of that matter. Without "has audio" a host offers back an empty
 * session created by a Record that was cancelled a second later, and the offer
 * becomes noise a user learns to dismiss. Without "no terminal state" it offers
 * back a meeting the user already finalized or explicitly threw away, which is
 * worse than noise — it is a product that will not let go of a recording someone
 * asked it to forget.
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
 * D2 — audio present, no terminal state.
 *
 * Status is deliberately not narrowed to `recording`: a session stopped by a
 * clean quit still holds audio that never finished transcribing, and D7 says it
 * should drain when the endpoint returns. Recovery is about unfinished work, not
 * about how the process died.
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
 */
export function orphanCaptureIds(
  storedCaptureIds: readonly string[],
  sessions: readonly MeetingCaptureSession[],
): readonly string[] {
  const known = new Set(sessions.map((session) => session.id));
  return storedCaptureIds.filter((id) => !known.has(id));
}
