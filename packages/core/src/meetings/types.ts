/**
 * ADR-035 — the shapes a meeting capture has to carry so it cannot be lost.
 *
 * §1 names the defect: audio lived in a React ref and a meeting row only
 * appeared once capture had already succeeded, so a failed capture had nowhere
 * to live and nothing to be retried from. Every type here exists to make one of
 * the ADR's decisions expressible:
 *
 * - D2 — a session exists from the moment Record is pressed, with an id the
 *   host names its capture directory (or its OPFS folder) after. That is what
 *   gives a crashed recording somewhere to be found again.
 * - D3 — the unit of transcription is a SEGMENT, so a failure is bounded to one
 *   segment rather than to the meeting, and nothing ever posts an hour of audio
 *   in one request.
 * - D5 — a segment that could not be transcribed keeps its time range, its
 *   reason and its attempt count. An unmarked hole in a transcript is quietly
 *   wrong; a stated gap is a fact someone can act on.
 *
 * Everything in this subsystem is pure data and pure functions: no filesystem,
 * no browser storage API, no network. That is deliberate and is what D1b means
 * by "the session model, the segment protocol, and the recovery flow are
 * shared — only the write target is host-specific". The desktop writes these
 * records next to files on disk; the dashboard writes them beside OPFS blobs;
 * both agree on what a meeting IS because both import this module.
 */

/**
 * D2 — the lifecycle of a capture, and the reason `recording` is a persisted
 * state rather than an in-memory one.
 *
 * A process that dies while recording leaves `recording` written down, and that
 * stale value is precisely the signal recovery looks for (`recovery.ts`).
 * `finalized` and `discarded` are the two terminal states, and they are distinct
 * because "the user accepted this meeting" and "the user threw it away" imply
 * different retention outcomes under D6.
 */
export type MeetingCaptureStatus = 'recording' | 'stopped' | 'finalized' | 'discarded';

/**
 * D3/D5 — where a single segment is in its transcription.
 *
 * `pending` and `transcribing` are both provisional in D4's sense; the split is
 * kept because "queued because the endpoint is down" (D7) and "in flight right
 * now" are different things to say to a user, and ADR-028 asks the surface to
 * say which state it is actually in.
 */
export type MeetingSegmentState = 'pending' | 'transcribing' | 'done' | 'failed';

/**
 * The summary templates a capture can be started with. The vocabulary matches
 * the one the hosts already offer rather than inventing a second one — a shared
 * model whose enumerations disagree with the surfaces is how ADR-029's "two
 * features, one quietly worse" failure starts.
 */
export type MeetingCaptureTemplate = 'general' | 'standup' | 'one-on-one' | 'retrospective';

/**
 * Open question 5 — the tenancy a capture was started under, frozen at Record.
 *
 * ADR-019's switcher can change the active org mid-meeting. Nothing in this
 * module rewrites `scope`, so a recording that started under one org cannot
 * silently land in another; recovery filters by it instead (`recovery.ts`).
 * `orgId` is nullable because a personal install genuinely has no org.
 */
export interface MeetingCaptureScope {
  readonly orgId: string | null;
  readonly workspaceId?: string | null;
}

/**
 * D3 — one chunk of audio and everything known about transcribing it.
 *
 * `byteLength` is what the host actually wrote, not what it intends to write:
 * the recovery predicate asks "is there audio" and a segment record that
 * anticipated bytes would answer yes for a session that has none.
 *
 * `startMs`/`endMs` are elapsed milliseconds from the start of the capture, not
 * wall clock. They are the range D5 prints in a gap marker, so they must stay
 * meaningful even for a session whose wall-clock start is unknown (an import).
 */
export interface MeetingSegment {
  readonly index: number;
  readonly byteLength: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly state: MeetingSegmentState;
  /** Present once `state` is `done`. Absent otherwise — never an empty placeholder. */
  readonly text?: string;
  /** D5 — why the last attempt failed, in words a user can act on. */
  readonly failureReason?: string;
  /** D5 — transcription attempts MADE (not queued). The bound in `retryPolicy.ts` reads this. */
  readonly attempts: number;
  /** ISO timestamp of the most recent attempt; the backoff clock starts here. */
  readonly lastAttemptAt?: string;
}

/**
 * D2 — the meeting itself, created at Record.
 *
 * The id is filesystem-safe by construction (`captureSession.ts` validates it)
 * because the host names a `0700` capture directory after it under D6. A
 * session with a path separator in its id would be a directory-traversal bug in
 * every host that stores audio, so the shared model refuses to mint one.
 */
export interface MeetingCaptureSession {
  readonly id: string;
  readonly startedAt: string;
  readonly scope: MeetingCaptureScope;
  readonly title: string;
  readonly template: MeetingCaptureTemplate;
  /** BCP-47 tag passed to STT, or absent to let the endpoint auto-detect. */
  readonly language?: string;
  readonly status: MeetingCaptureStatus;
  readonly segments: readonly MeetingSegment[];
  /** Set when capture stopped; cleared again if the user resumes. */
  readonly stoppedAt?: string;
  /** Set once `status` is terminal (`finalized` or `discarded`). */
  readonly closedAt?: string;
}
