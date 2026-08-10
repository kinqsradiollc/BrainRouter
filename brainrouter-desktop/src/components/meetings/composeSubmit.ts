/**
 * ADR-035 D5/D6 — what "Create meeting" posts, and when it must not post at all.
 *
 * ## What it owns
 *
 * Two things, and the second exists to make the first answerable.
 *
 * 1. Given the compose form as it stands, what is the `CreateMeetingInput` this
 *    click should send, and under which organization.
 * 2. `MeetingCaptureHold` — what the form is holding while it answers — and the
 *    single writer that keeps its synchronous and rendered copies equal.
 *
 * No ops, no React, no draft store, no textarea: what is here is what a test can
 * hold to a string, which is the whole reason it is a module and not four lines
 * inside a `useCallback`.
 *
 * It was four lines inside a `useCallback`, and that is exactly how it stayed
 * untested: deleting `body = settled.text` left every renderer test and the
 * whole source-text contract green, while the meeting it posted lost its gap
 * marker AND the segment after it — and `submit` then released the audio that
 * was the only other copy. A step whose result the caller may quietly drop is a
 * step no assertion can hold, so the result is now the entire input object and
 * the caller has nothing left to assemble.
 *
 * ## The invariants
 *
 * 1. **A capture that is still being written to cannot be submitted.** Create
 *    finalizes the capture, which under D6 deletes the directory the recorder is
 *    appending to. `recording` alone does not cover that: Record has a window
 *    before the recorder is running (`arming`) and Stop has a window after it
 *    stops (`closing`) — the final chunk's `arrayBuffer`, the IPC and the disk
 *    write all happen after `stopRecording` has already set `recording` false.
 *    A click landing in the second window posted a transcript missing its last
 *    chunk with NO gap marker (there was no segment yet for anything to state),
 *    warned about nothing beforehand because `unsettledSegments` was zero, and
 *    then deleted the audio it was the only copy of.
 * 2. **Nothing unresolved is dropped in silence.** `settleTranscriptForSubmit`
 *    is the shared rule: the meeting is created from this text, so a segment
 *    still in flight will never reach it and goes in as a stated gap with its
 *    time range. That is the same thing `finalizeCapture` does to the record a
 *    moment later, and D5 calls the alternative — an unmarked hole — worse than
 *    a transcript that says `00:12:30–00:13:00 could not be transcribed`.
 * 3. **A meeting is filed where the RECORDING began.** Open question 5: the
 *    active org comes from the app-wide switcher and can move while a meeting is
 *    being recorded; the capture's scope is frozen at Record and nothing
 *    rewrites it. With no capture behind the text (a pasted or imported
 *    transcript) there is no frozen scope, and the switcher is the only truth
 *    there is.
 * 4. **Nor can a capture ANOTHER window is recording.** The same consequence as
 *    invariant 1, reached by a mechanism invariant 1 cannot see: the hold is
 *    this window's own state, and a second BrowserWindow's hold is empty, so
 *    every boolean in it reads false about a meeting being recorded next door.
 *    That question is therefore asked of the RECORD, through the shared capture
 *    lease, which every holder of the store reads the same way. The two guards
 *    are both needed and neither subsumes the other: the lease cannot cover
 *    `arming` (no session exists yet) and the hold cannot cover another window.
 */
import {
  describeCaptureWriter,
  settleTranscriptForSubmit,
  type MeetingCaptureSession,
  type TranscriptFold,
} from "@kinqs/brainrouter-core/meetings";
import type { CreateMeetingInput } from "./types.js";

/**
 * The capture the compose form is holding, as everything outside the form needs
 * to see it.
 *
 * `sessionId` is the capture in hand — a live recording, OR a recovery this form
 * adopted — and is what keeps the recovery offer from advertising it back while
 * the microphone is still open. The three booleans are the windows in which a
 * capture is being written to; they are separate because they are separately
 * reachable and each one was its own click.
 */
export interface MeetingCaptureHold {
  /** The capture this form holds: a live recording, or an adopted recovery. */
  readonly sessionId: string | null;
  /** The microphone is open. */
  readonly recording: boolean;
  /** Record was pressed and the recorder is not running yet — or has failed to start. */
  readonly arming: boolean;
  /** Stop was pressed and the final chunk has not finished being written. */
  readonly closing: boolean;
}

export const NO_CAPTURE_HOLD: MeetingCaptureHold = {
  sessionId: null,
  recording: false,
  arming: false,
  closing: false,
};

/**
 * The hold's two copies, and the single writer that keeps them equal.
 *
 * A surface needs it twice over and neither copy will do for the other's job.
 * A rule — `submit`'s guard, the progress subscription's filter — must read
 * what is true at the instant it runs; React's rendered copy lags a commit, and
 * the whole of F3 is a window one commit wide. A button and an effect can only
 * read what was rendered. Two `useState`/`useRef` mirrors written by hand at
 * six call sites is how they come apart, so they are written here, together,
 * and the component keeps no second way to move one.
 */
export interface CaptureHoldStore {
  /** The hold as it is RIGHT NOW. What a rule reads. */
  readonly current: MeetingCaptureHold;
  /** Apply a patch, publish the result for rendering, and return it. */
  update(patch: Partial<MeetingCaptureHold>): MeetingCaptureHold;
}

export function createCaptureHold(publish: (hold: MeetingCaptureHold) => void): CaptureHoldStore {
  let current = NO_CAPTURE_HOLD;
  return {
    get current() { return current; },
    update(patch) {
      current = { ...current, ...patch };
      publish(current);
      return current;
    },
  };
}

/**
 * Invariant 1 — is a capture still being written to.
 *
 * Read twice on purpose: once by the rule below, from the values that are true
 * right now, and once by the button, from the state React has rendered. The
 * button is a statement about a pixel; this is the rule.
 */
export function captureInFlight(hold: MeetingCaptureHold): boolean {
  return hold.recording || hold.arming || hold.closing;
}

export interface MeetingSubmissionInput {
  readonly title: string;
  readonly template: CreateMeetingInput["template"];
  /** The compose box as the person currently sees it. */
  readonly transcript: string;
  /** The capture behind that text, as the host last persisted it. */
  readonly session: MeetingCaptureSession | null;
  readonly fold: TranscriptFold;
  readonly hold: MeetingCaptureHold;
  readonly busy: boolean;
  /** The workspace the app-wide switcher is on. Used only when no capture is behind the text. */
  readonly activeOrgId?: string;
  /**
   * Invariant 4 — this WINDOW's capture-lease identity.
   *
   * Optional, and its absence means "the caller will not say who it is", which
   * the shared rule reads as "not the writer" — so an anonymous caller is
   * refused over any live recording rather than being quietly exempted.
   */
  readonly holderId?: string;
}

/** Why a click did nothing — named so a test can tell "refused" from "posted nothing". */
export type MeetingSubmissionRefusal = "incomplete" | "busy" | "capture-in-flight" | "held-by-another";

export interface PreparedMeetingSubmission {
  readonly ok: true;
  /** Everything the create call sends. The caller assembles no part of this. */
  readonly input: CreateMeetingInput;
  /** Invariant 3 — the org this meeting is filed under, or undefined for the account default. */
  readonly orgId?: string;
  /** The fold advanced past everything this text now states. */
  readonly fold: TranscriptFold;
  /** False when the box already said all of it, so the caller can skip a state update. */
  readonly changed: boolean;
  /** Segment indices that went in as stated gaps — what was warned about, actually spent. */
  readonly stated: readonly number[];
}

export type MeetingSubmission =
  | PreparedMeetingSubmission
  | { readonly ok: false; readonly reason: MeetingSubmissionRefusal };

export function prepareSubmission(state: MeetingSubmissionInput): MeetingSubmission {
  // Ordered so the destructive condition is reported as itself: a running
  // capture with an empty title is refused for the capture, because that is the
  // one a caller must not resolve by filling the form in.
  if (captureInFlight(state.hold)) return { ok: false, reason: "capture-in-flight" };
  // Invariant 4, and the reason it is a SECOND question rather than the same
  // one: the hold is this window's memory, and the whole defect is that a second
  // window's hold is empty. `captureInFlight` covers the two windows the record
  // cannot — Record before a session exists, and Stop after the last chunk — and
  // the lease covers the writer this window has never heard of.
  if (state.session && describeCaptureWriter(state.session, state.holderId)) {
    return { ok: false, reason: "held-by-another" };
  }
  if (state.busy) return { ok: false, reason: "busy" };
  const title = state.title.trim();
  if (!title || !state.transcript.trim()) return { ok: false, reason: "incomplete" };
  const settled = settleTranscriptForSubmit(state.transcript, state.session, state.fold);
  const orgId = state.session ? state.session.scope.orgId ?? undefined : state.activeOrgId;
  return {
    ok: true,
    input: {
      title,
      transcript: settled.text,
      ...(state.template ? { template: state.template } : {}),
    },
    ...(orgId ? { orgId } : {}),
    fold: settled.fold,
    changed: settled.changed,
    stated: settled.stated,
  };
}
