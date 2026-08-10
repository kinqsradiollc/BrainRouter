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
 *
 * **Liveness is deliberately NOT in this envelope.** It was: a lease with a
 * heartbeat stamp, mirrored beside the session so a damaged payload still named
 * its writer. On this host that answer is `captureLock.ts` — a Web Lock, held for
 * the life of the recording and released by the BROWSER when the tab dies — so a
 * stamp here could only ever be a second, slower opinion about the same fact.
 * Worse, a stale one: after a kill the stamp stays fresh for the length of the
 * old threshold, and a session restored with it would be withheld from the
 * recovery offer for exactly as long as §6 says it must not be. So a lease found
 * in a record written by an older build is READ AND DROPPED, not honoured.
 */
import {
  adoptCaptureChunks,
  createCaptureSession,
  DEFAULT_MEETING_SEGMENT_MS,
  isMeetingSessionId,
  recoverCaptureSession,
  resumableSessions,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingSegment,
} from "@kinqs/brainrouter-core/meetings";

import type { CaptureSessionRecord } from "./captureStore";

/**
 * The envelope written to the manifest.
 *
 * `mimeType` is beside the session rather than in it because it is a property of
 * THIS host's `MediaRecorder`, not of what a meeting is — the desktop answers
 * the same question with its own `contentType` field. `title` is kept
 * separately too, so a capture recorded before the session model existed still
 * comes back with its name.
 *
 * There is no `writer` field. The envelope describes what the meeting IS; who is
 * writing to it at this instant is a question about live tabs, and it is asked
 * of the browser (`captureLock.ts`) rather than of bytes that were written down
 * some unknown time ago.
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
 *    segment. That rule is the SHARED `adoptCaptureChunks` — both hosts had
 *    written it out for themselves, and a pure rule kept aligned by attention is
 *    a rule that is one edit away from diverging. What is left here is the
 *    host-specific half: this store leaves the chunks past a hole where they are
 *    (`rejected`) for its own reap to claim, rather than deleting them.
 * 3. **Recover.** `recoverCaptureSession` is the shared rule: nothing is
 *    recording any more, and a segment left mid-attempt did not succeed. It runs
 *    LAST because step 2 needs a session that still accepts appends.
 */
export function restoreCaptureSession(input: RestoreCaptureInput): MeetingCaptureSession {
  const payload = parseCapturePayload(input.record.payload);
  const stored = payload.session && payload.session.id === input.record.sessionId
    ? payload.session
    : createCaptureSession({
      id: isMeetingSessionId(input.record.sessionId) ? input.record.sessionId : undefined,
      startedAt: input.record.startedAt,
      scope: input.scope,
      ...(payload.title ? { title: payload.title } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
  // A lease written by an older build is dropped here. `isResumableSession` no
  // longer reads it — the field is gone from the shared model and
  // `recoverCaptureSession` drops it too — so this is belt to that braces, and
  // it stays because it is the earlier of the two: a stamp reaches adoption
  // before it reaches recovery, and a terminal session skips recovery
  // altogether. Cast because the shape is no longer part of a session; what is
  // read here is what an older build left on the device. Liveness on this host
  // is the Web Lock, and only the Web Lock.
  const { writer: _legacy, ...adopted } = stored as MeetingCaptureSession & { writer?: unknown };
  const reconciled = adoptCaptureChunks(adopted, input.record.chunks, {
    segmentMs: input.segmentMs ?? DEFAULT_MEETING_SEGMENT_MS,
  });
  return recoverCaptureSession(reconciled.session, input.at);
}

/**
 * Open question 5 — a stored capture, restored, alongside the record its audio
 * still lives in.
 *
 * Both halves are needed by the surface and neither is derivable from the other:
 * the session is what `summarizeRecovery` describes and what a pick-up resumes,
 * and the record is what Play reads and what Discard deletes.
 */
export interface ResumableCapture {
  readonly record: CaptureSessionRecord;
  readonly session: MeetingCaptureSession;
}

export interface ResumableCaptureOptions {
  /**
   * The workspace in context. A capture recorded under one organization is not
   * offered back under another — ADR-019's switcher can move while a meeting is
   * unfinished, and the offer is precisely where that recording would change
   * hands.
   */
  readonly scope: MeetingCaptureScope;
  /**
   * Ids to leave out whatever their record says.
   *
   * Two kinds, and the second is the whole of "a live recording is not offered
   * back": the capture in hand, which is unfinished by definition and would be
   * nonsense to offer while its microphone is still open, and every capture some
   * tab of this origin currently HOLDS THE LOCK for. The record cannot answer
   * that second one — nothing in it is about live tabs — so the caller asks
   * `captureLock.ts` and hands the answer in here.
   */
  readonly exclude?: readonly string[];
  /**
   * The instant the offer is judged at, threaded so the recovery stamp is a
   * reading a test can pin rather than whatever the wall clock said between two
   * statements.
   */
  readonly at?: string;
}

/**
 * D2's recovery offer for this host, decided by the SHARED predicate.
 *
 * The store cannot answer this: it treats `payload` as opaque text on purpose,
 * so it can see neither a session's scope nor its terminal state, and the
 * `!closed && byteLength > 0` it used to filter by was D2's rule written down a
 * second time — one that could not have a scope in it and drifted the moment
 * open question 5 was answered. This module owns the record → session mapping,
 * so it is where `resumableSessions` can be asked instead of imitated.
 */
export function resumableCaptures(
  records: readonly CaptureSessionRecord[],
  options: ResumableCaptureOptions,
): readonly ResumableCapture[] {
  const excluded = new Set(options.exclude ?? []);
  const at = options.at ?? new Date().toISOString();
  const candidates = records
    .filter((record) => !excluded.has(record.sessionId))
    // `closed` is not a second opinion about terminality — it IS
    // `isTerminalCaptureStatus`, written by the queue's persist so the store can
    // answer without parsing anything. Honouring it first is what covers the one
    // case restoring cannot: a payload too damaged to read yields a freshly
    // minted RECORDING session over the chunks, which would offer back a meeting
    // the user finalized or explicitly threw away.
    .filter((record) => !record.closed)
    .map((record) => ({ record, session: restoreCaptureSession({ record, scope: options.scope, at }) }));
  // No instant is threaded into the shared rule, because it no longer has one to
  // take: "audio present, no terminal state" is a question about a record, and
  // every answer it used to give a clock was an answer about a writer that had
  // already been killed. `at` above still stamps the RECOVERY, which is a fact
  // about when this launch found the meeting.
  const offered = new Set(
    resumableSessions(candidates.map((candidate) => candidate.session), { scope: options.scope })
      .map((session) => session.id),
  );
  // Ordered by the shared rule's own answer (newest first), not by the store's
  // listing: two surfaces that sort a recovery offer differently are two
  // surfaces a user has to learn twice.
  return candidates
    .filter((candidate) => offered.has(candidate.session.id))
    .sort((left, right) => right.session.startedAt.localeCompare(left.session.startedAt));
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
