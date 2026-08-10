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
  /**
   * D7 — how many times an attempt on THIS segment was refunded because the
   * endpoint did not answer.
   *
   * It is not `attempts`, and the split is the whole point: an outage is a
   * verdict on the server, so the attempt is given back. But the give-back has
   * to be bounded or a server that answers every request with a "try again
   * later" status — including one that is really saying "these bytes will never
   * decode" — is an unbounded upload loop against our own sidecar, with the
   * segment sitting at `attempts: 0` forever and the transcript never admitting
   * anything is wrong.
   *
   * Absent until an outage actually touches the segment: most segments in a
   * meeting never see one, and a `0` written 180 times is noise in the record.
   */
  readonly deferrals?: number;
  /** ISO timestamp of the most recent attempt; the backoff clock starts here. */
  readonly lastAttemptAt?: string;
}

/**
 * D2/D6 — the writer that is appending to this capture right now, expressed IN
 * THE RECORD so that every holder of the store reads the same answer.
 *
 * It lives here, on the meeting, rather than beside the store, because that is
 * the whole correction: a `MeetingCaptureStore` is per-process on the desktop
 * and per-origin in the browser, so a second window or a second tab holds the
 * SAME store with none of the first one's memory. Liveness kept in either
 * holder's memory is invisible to the other, and what the other then does is
 * offer a live recording back as resumable with an enabled Delete.
 *
 * The rules — freshness, acquisition, the heartbeat, the fencing epoch — are in
 * `captureLease.ts`; only the shape is here, because this is what a host
 * serializes into `session.json` or into an OPFS manifest.
 */
export interface MeetingCaptureLease {
  /** One writer: a window or a tab, never a process or an origin. */
  readonly holderId: string;
  /**
   * Bumped by every ACQUISITION and by nothing else, so a writer that lost the
   * recording while it was stalled cannot renew its way back in (ADR-029 B2/Q1,
   * migration 048: a lease without a fencing token is not a lock).
   */
  readonly epoch: number;
  /** ISO instant of the last "I am still here". Expiry is measured from this and nothing else. */
  readonly heartbeatAt: string;
  /** What a surface calls this writer — "another window", "another tab". */
  readonly holder?: string;
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
  /**
   * Who is writing to this capture right now, if anyone. Absent means nobody has
   * ever claimed it; a lapsed lease is kept rather than removed, because the
   * fencing epoch has to outlive its term (`captureLease.ts`).
   */
  readonly writer?: MeetingCaptureLease;
}
