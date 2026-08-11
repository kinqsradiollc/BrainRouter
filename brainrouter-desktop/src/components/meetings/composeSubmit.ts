/**
 * ADR-035 D5/D6 — what "Create meeting" posts, and when it must not post at all.
 *
 * ## What it owns
 *
 * Three things, and the second and third exist to make the first answerable.
 *
 * 1. Given the compose form as it stands, what is the `CreateMeetingInput` this
 *    click should send, and under which organization.
 * 2. `MeetingCaptureHold` — what the form is holding while it answers — and the
 *    single writer that keeps its synchronous and rendered copies equal.
 * 3. `ComposeFormLife` — which life of the form an async answer belongs to, so a
 *    step that crosses an await can tell that the form it started in has gone.
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
 *    That question is answered by MAIN, which holds every window of this process
 *    and therefore knows exactly; `heldByAnother` is that answer as this window
 *    last heard it. The two guards are both needed and neither subsumes the
 *    other: main cannot cover `arming` (no session exists yet) and the hold
 *    cannot cover another window.
 *
 *    This one is an affordance rather than the enforcement. The refusal that
 *    matters is main's — `submit` finalizes the capture, and main throws over a
 *    capture another window is recording — because a rule reading state this
 *    window fetched a moment ago is a rule that can be a moment out of date.
 * 5. **A capture is IN HAND from Record until it is FILED** — created or
 *    discarded — and not one moment less. Not until Stop, which ends the
 *    microphone and nothing else; not until the settle, which decides what the
 *    POST says and releases nothing. The hold used to keep one `sessionId`, so
 *    Record → Stop → Record silently dropped the first capture the instant the
 *    second one existed: both halves went into one meeting, only the last was
 *    finalized, and D6's "audio is deleted when the meeting is summarized and
 *    the user has accepted it" was simply not kept for the first — whose audio
 *    then came back as an unfinished-recording offer inviting a duplicate of
 *    text already filed. So the hand is a LIST, `sessionId` is only the one the
 *    live rows are bound to, and every id in the list is excluded from the
 *    offer, released by Create, and dropped by `file`.
 */
import {
  settleTranscriptForSubmit,
  type MeetingCaptureSession,
  type TranscriptFold,
} from "@kinqs/brainrouter-core/meetings";
import type { CreateMeetingInput } from "./types.js";

/**
 * The captures the compose form is holding, as everything outside the form needs
 * to see them.
 *
 * `sessionId` is the one the LIVE SURFACE is bound to — the recording being made,
 * or the recovery just adopted — and it is what the progress subscription filters
 * on and what the retry acts on. `inHand` is invariant 5: every capture this form
 * has taken and not yet filed, which is the set the offer must not advertise and
 * the set Create releases. They are usually the same one capture; they come apart
 * the moment a second Record lands on a form that already holds one.
 *
 * The three booleans are the windows in which a capture is being WRITTEN to; they
 * are separate because they are separately reachable and each one was its own
 * click. None of them says anything about the hand: a stopped capture is not
 * being written to and is still very much in it.
 */
export interface MeetingCaptureHold {
  /** The capture the live rows, the progress filter and the retry are bound to. */
  readonly sessionId: string | null;
  /**
   * Invariant 5 — every capture taken and not yet filed, oldest first. Contains
   * `sessionId` whenever that is set, and outlives it: Record → Stop → Record
   * leaves the first capture here until the create releases it.
   */
  readonly inHand: readonly string[];
  /** The microphone is open. */
  readonly recording: boolean;
  /** Record was pressed and the recorder is not running yet — or has failed to start. */
  readonly arming: boolean;
  /** Stop was pressed and the final chunk has not finished being written. */
  readonly closing: boolean;
}

export const NO_CAPTURE_HOLD: MeetingCaptureHold = {
  sessionId: null,
  inHand: [],
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
  /**
   * Apply a patch, publish the result for rendering, and return it.
   *
   * Binding a `sessionId` also TAKES that capture: invariant 5 is maintained
   * here rather than by the six call sites, because "the form now holds this
   * recording" and "the live rows now point at it" are the same event and a
   * caller that had to say both is a caller that can say one.
   */
  update(patch: CaptureHoldPatch): MeetingCaptureHold;
  /**
   * Invariant 5 — this capture is filed: created, or discarded. It leaves the
   * hand, and the live binding with it if that is what it was.
   *
   * The only way out. Setting `sessionId` to null does NOT release a capture —
   * that was the defect — because a form can stop rendering a capture's rows
   * long before anything has been done with its audio.
   */
  file(sessionId: string): MeetingCaptureHold;
}

/** Everything a caller may set. `inHand` is not on it: it is taken and filed, never assigned. */
export type CaptureHoldPatch = Partial<Omit<MeetingCaptureHold, "inHand">>;

export function createCaptureHold(publish: (hold: MeetingCaptureHold) => void): CaptureHoldStore {
  let current = NO_CAPTURE_HOLD;
  const commit = (next: MeetingCaptureHold): MeetingCaptureHold => {
    current = next;
    publish(current);
    return current;
  };
  return {
    get current() { return current; },
    update(patch) {
      const taken = patch.sessionId;
      // The array identity is reused when the set does not change, because it is
      // an effect dependency on the other side of `publish`: a fresh `[]` on
      // every keystroke-driven patch would re-query the offer on each one.
      const inHand = taken && !current.inHand.includes(taken)
        ? [...current.inHand, taken]
        : current.inHand;
      return commit({ ...current, ...patch, inHand });
    },
    file(sessionId) {
      // A capture that was never in hand — a recovery row discarded straight
      // from the offer — changes nothing, and publishing an identical hold would
      // re-run the effects that read it.
      if (!current.inHand.includes(sessionId)) return current;
      return commit({
        ...current,
        inHand: current.inHand.filter((id) => id !== sessionId),
        ...(current.sessionId === sessionId ? { sessionId: null } : {}),
      });
    },
  };
}

/**
 * §6 — which LIFE of the compose form an async answer belongs to.
 *
 * `playCapture` reads a whole recording back across an await and then mints an
 * object URL over the bytes. A URL minted for a form that has already gone is
 * one nothing will ever revoke — React drops the `setPreview`, and the revoking
 * effect went with the form — so a whole meeting stays pinned in the window's
 * heap. That is §1's defect in miniature, which is why the step asks.
 *
 * **It is a counter and not a boolean, and that is the decision rather than the
 * detail.** The boolean was a `useRef(true)` cleared by the form's unmount
 * cleanup and set back by nothing, and React does not promise that a cleanup is
 * the end of an instance: it may run one and then run the setup again on the
 * same instance, which is precisely what StrictMode's double invoke does on
 * every mount in `vite dev`. A latch lowered there can never be raised, so ▶
 * Play returned silently for the rest of that page view and §6's "on disk and
 * PLAYABLE" was broken in the environment this is developed in. A life is read
 * at the START of each attempt, so a form that outlives a teardown simply has a
 * new life and its next attempt is in it. Same shape, and the same reason, as
 * `MeetingCaptureRecorder.attempt`: what is cancelled is one ATTEMPT.
 */
export interface ComposeFormLife {
  /** The life this step belongs to. Read before its first await, never after. */
  begin(): number;
  /** Has the form been torn down since that step began? */
  ended(life: number): boolean;
  /** This form's effects have been torn down. */
  retire(): void;
}

export function createComposeLife(): ComposeFormLife {
  let life = 0;
  return {
    begin: () => life,
    ended: (started) => started !== life,
    retire: () => { life += 1; },
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
   * Invariant 4 — main says another window is recording the capture behind this
   * text.
   *
   * A boolean rather than an identity to compare, because the comparison is not
   * this module's to make: main holds every window and answers it exactly, and a
   * rule that re-derived it here from a record would be re-deriving it from
   * something that cannot see a second window at all.
   */
  readonly heldByAnother?: boolean;
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
  // window's hold is empty. `captureInFlight` covers the two moments main cannot
  // — Record before a session exists, and Stop after the last chunk — and this
  // covers the writer this window has never heard of.
  if (state.heldByAnother) return { ok: false, reason: "held-by-another" };
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
