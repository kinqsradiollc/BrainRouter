/**
 * ADR-035 D2/D3 — what the dashboard keeps in the capture manifest, and how a
 * meeting is put back together from it after the tab is gone.
 *
 * `captureStore.ts` deliberately treats the manifest `payload` as opaque text:
 * the store owns bytes and ordering, not what a meeting IS. This module is the
 * other side of that seam — it owns the envelope, and it is the ONLY place that
 * turns stored bytes back into a `MeetingCaptureSession`.
 *
 * The session model itself is imported, not restated (D1b: "the session model,
 * the segment protocol, and the recovery flow are shared — only the write target
 * is host-specific"). Everything below is the host-specific half: JSON in a
 * browser store, and the reconciliation between what the store actually holds
 * and what the last successful write claimed.
 *
 * That reconciliation is the point of the module, and it is not bookkeeping.
 * `captureStore.ts` states the invariant it lives by — "the bytes are the truth;
 * the manifest is a convenience" — because D1b says a closing tab gets very
 * little time. So a chunk can land and the session write that was supposed to
 * mention it can not. Read the manifest alone and that audio is invisible
 * forever: on disk, holding quota, in no transcript, offered back by nothing.
 * `restoreCaptureSession` closes that gap by believing the chunks.
 *
 * The other invariant here, which the transcription queue depends on absolutely:
 * **a segment's `index` equals its chunk's `sequence` in the store.** The
 * queue's `readSegment(index)` port reads chunk `index`, so if those ever
 * diverged, every segment after the divergence would be transcribed from the
 * wrong audio — silently, with plausible text. Nothing here appends a segment
 * for a chunk whose sequence is not exactly the next index.
 */
import {
  appendSegment,
  createCaptureSession,
  DEFAULT_MEETING_SEGMENT_MS,
  isMeetingSessionId,
  isTerminalCaptureStatus,
  recoverCaptureSession,
  resumeCapture,
  stopCapture,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingSegment,
} from "@kinqs/brainrouter-core/meetings";

import type { CaptureChunkRef } from "./captureStorage";
import type { CaptureSessionRecord } from "./captureStore";

/**
 * The envelope written to the manifest.
 *
 * `mimeType` is beside the session rather than in it because it is a property of
 * THIS host's `MediaRecorder`, not of what a meeting is — the desktop answers
 * the same question with its own `contentType` field. `title` is kept
 * separately too, so a capture recorded before the session model existed still
 * comes back with its name.
 */
export interface CapturePayload {
  readonly title?: string;
  readonly mimeType?: string;
  readonly session?: MeetingCaptureSession;
}

export function serializeCapturePayload(payload: CapturePayload): string {
  return JSON.stringify(payload);
}

/**
 * Read the envelope, tolerating anything.
 *
 * Never throws. A payload we cannot read must not make the audio beside it
 * unreachable — that would turn a one-byte JSON problem into a lost meeting,
 * which is the trade this ADR exists to refuse.
 */
export function parseCapturePayload(text: string): CapturePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const candidate = parsed as { title?: unknown; mimeType?: unknown; session?: unknown };
  return {
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.mimeType === "string" ? { mimeType: candidate.mimeType } : {}),
    ...(isStoredSession(candidate.session) ? { session: candidate.session } : {}),
  };
}

export interface RestoreCaptureInput {
  readonly record: CaptureSessionRecord;
  /**
   * The scope to mint a session under when the manifest has none. It is NOT
   * applied to a session that already has one: open question 5 — a recording
   * started under one org must not silently land in another, and the moment it
   * is offered back is exactly where that would happen.
   */
  readonly scope: MeetingCaptureScope;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
  /** Duration credited to a chunk the manifest never described. */
  readonly segmentMs?: number;
  /** ISO instant used for the recovery stamp; injected by tests. */
  readonly at?: string;
}

/**
 * D2's recovery half — the session a stored capture actually represents.
 *
 * Three things happen, in this order, and the order matters:
 *
 * 1. **Adopt or mint.** A manifest written by this build carries the session. A
 *    capture recorded before it did (or one whose payload is unreadable) gets a
 *    fresh session minted over the same id, so old recordings keep working
 *    rather than becoming unreachable audio.
 * 2. **Believe the chunks.** Any chunk the session does not describe becomes a
 *    segment. This is what makes a write that never landed cost a late record
 *    instead of lost audio.
 * 3. **Recover.** `recoverCaptureSession` is the shared rule: nothing is
 *    recording any more, and a segment left mid-attempt did not succeed. It runs
 *    LAST because step 2 needs a session that still accepts appends.
 */
export function restoreCaptureSession(input: RestoreCaptureInput): MeetingCaptureSession {
  const payload = parseCapturePayload(input.record.payload);
  const adopted = payload.session && payload.session.id === input.record.sessionId
    ? payload.session
    : createCaptureSession({
      id: isMeetingSessionId(input.record.sessionId) ? input.record.sessionId : undefined,
      startedAt: input.record.startedAt,
      scope: input.scope,
      ...(payload.title ? { title: payload.title } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
  const reconciled = adoptChunks(adopted, input.record.chunks, input.segmentMs ?? DEFAULT_MEETING_SEGMENT_MS);
  return recoverCaptureSession(reconciled, input.at);
}

/**
 * Record every chunk the session does not yet describe.
 *
 * Stops at the first sequence that is not the next index. A hole means the store
 * lost a chunk's bytes, and inventing a segment to bridge it would hand the
 * queue an index that reads somebody else's audio — the one failure mode worse
 * than an unclaimed chunk, because it produces text that looks right.
 */
export function adoptChunks(
  session: MeetingCaptureSession,
  chunks: readonly CaptureChunkRef[],
  segmentMs: number,
): MeetingCaptureSession {
  // D6 — a finalized or discarded meeting has had its audio released; anything
  // still stored for it is an orphan for the reap, not work to adopt.
  if (isTerminalCaptureStatus(session.status)) return session;
  const pending = chunks
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .filter((chunk) => chunk.sequence >= session.segments.length && chunk.byteLength > 0);
  if (pending.length === 0) return session;

  // `appendSegment` only accepts a recording session, so a cleanly stopped one is
  // resumed for the append and stopped again with its ORIGINAL timestamp — the
  // recording did not restart, and rewriting `stoppedAt` would misreport when.
  const stoppedAt = session.status === "stopped" ? session.stoppedAt : undefined;
  let next = session.status === "recording" ? session : resumeCapture(session);
  for (const chunk of pending) {
    if (chunk.sequence !== next.segments.length) break;
    next = appendSegment(next, { byteLength: chunk.byteLength, durationMs: segmentMs });
  }
  return session.status === "recording" ? next : stopCapture(next, stoppedAt);
}

const SEGMENT_STATES = new Set(["pending", "transcribing", "done", "failed"]);
const CAPTURE_STATUSES = new Set(["recording", "stopped", "finalized", "discarded"]);

/**
 * Structural validation of a session read back out of browser storage.
 *
 * Not paranoia about an attacker — IndexedDB and OPFS are origin-scoped — but
 * about our own past selves: a session shape written by an older build, or a
 * half-written record, must degrade to "mint a fresh one from the chunks"
 * instead of feeding the queue a segment list with holes in it.
 */
function isStoredSession(value: unknown): value is MeetingCaptureSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MeetingCaptureSession> & { scope?: unknown };
  if (!isMeetingSessionId(candidate.id) || typeof candidate.startedAt !== "string") return false;
  if (typeof candidate.status !== "string" || !CAPTURE_STATUSES.has(candidate.status)) return false;
  if (!candidate.scope || typeof candidate.scope !== "object") return false;
  if (!Array.isArray(candidate.segments)) return false;
  return candidate.segments.every(isStoredSegment);
}

function isStoredSegment(value: unknown, position: number): value is MeetingSegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Partial<MeetingSegment>;
  // The index must be the position: it is the chunk sequence the queue reads
  // audio from, so a list whose indices have drifted is not repairable here.
  if (segment.index !== position) return false;
  if (!Number.isFinite(segment.byteLength) || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) {
    return false;
  }
  if (!Number.isFinite(segment.attempts)) return false;
  return typeof segment.state === "string" && SEGMENT_STATES.has(segment.state);
}
