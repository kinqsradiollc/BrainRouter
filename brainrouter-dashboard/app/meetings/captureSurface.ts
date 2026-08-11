/**
 * ADR-035 D1b/D2/D6 — everything the dashboard does with a recording that is
 * still being written, as one object a test can drive.
 *
 * **Why this is not in `page.tsx`.** It was, and that is the structural cause
 * behind the defects this ADR keeps repairing on this host. A 1900-line React
 * component can only be checked by reading its source, so every guard it grew
 * was pinned by a regular expression over the text of the file — and a regular
 * expression cannot tell you what a value WAS. Three rounds of that produced,
 * in order: a `base:` field respelled with all tests green (the doubled
 * transcript), a `transcript = settled.text` line deleted with all tests green
 * (the unmarked hole), and `meetingOrgId` respelled as `activeOrgId` which
 * nothing could have caught at all (a meeting landing in the wrong workspace).
 * The fix is not a stricter regular expression. It is that the decisions leave
 * the component, so a test can press Record, hand it a chunk, kill it, and read
 * what actually reached the POST.
 *
 * So this owns the decisions and `page.tsx` owns the pixels. The seam is a plain
 * object with a snapshot and a subscription — no React in this file, which is
 * the property that makes it testable in a runner with no DOM in it, exactly as
 * `captureStore.ts` is testable in a runner with no OPFS in it and for the same
 * reason: logic no test can execute is logic nobody has checked, and this is the
 * module whose whole job is not losing a recording.
 *
 * **Liveness is the browser's, not this object's and not the record's.** Four
 * rounds of guards — `captureRef.current`, `queueRef.current` here,
 * `hold.sessionId` and `captureInFlight(hold)` on the desktop — were the same
 * mistake four times: state in ONE mount describing a store scoped to the whole
 * ORIGIN. A second tab has an empty guard, so every "is something recording?"
 * question answers false and the live meeting is offered back with an enabled
 * Discard beside it.
 *
 * The fifth round moved the fact into the record as a LEASE, and that was the
 * same mistake once more in a longer form: a heartbeat and a staleness threshold
 * are a guess about a question this host can answer exactly. The guess cost §6
 * its headline — after a real kill the stamp stays fresh, so a reopened tab is
 * shown an empty device holding a complete, playable meeting, and it never
 * corrects itself because the offer is computed on mount and nothing re-asks.
 *
 * So the question goes to `navigator.locks` (`captureLock.ts`): a lock over the
 * capture id, exclusive across every tab of the origin, taken before the
 * microphone is even asked for, and released BY THE BROWSER the instant the tab
 * dies. There is no clock in it, no threshold to tune, and no window in which a
 * dead writer looks alive — so the four places that can destroy a recording (the
 * offer, the discard, the reap and the create guard) ask it and get today's
 * answer rather than one from up to thirty seconds ago.
 *
 * **And `recording` is not the question — nor is "in flight".** Every control
 * that can start or adopt a capture used to key its guard, and its `disabled`,
 * on that one flag, which is false for the whole arming window (a
 * persistent-storage prompt, then the microphone prompt, both of which a person
 * can leave on screen) and false again across the settle after Stop. Widening it
 * to "in flight" — arming, or recording, or a settle still landing — MOVED the
 * hole rather than closing it: `#finishCapture` lets go of the recording in hand
 * the instant the last chunk lands, so one tick after Stop every control was
 * live again over a compose box that still holds a meeting nobody has filed.
 * Pressed there, Record folds a second meeting's words into the first one's box
 * and Create posts the two as one; Pick up does the same and then releases the
 * ADOPTED audio, leaving the recording just made on the device to be offered
 * back.
 *
 * The question is IN HAND: a capture is in this tab's hands from the press of
 * Record — or of Pick up — until it is FILED, which is the meeting created or
 * the recording discarded, and that covers the settle and the whole
 * compose-and-review period while somebody is still typing a title. In code it
 * is `#claiming || #queue !== null`, and `#release` is the only thing that drops
 * the queue: its callers are a create that succeeded and a discard. Stop does
 * not clear it, the settle does not clear it, and closing the dialog does not
 * clear it. It is published as `capturing` so a button cannot promise what a
 * function will refuse, and the refusal is in the FUNCTION as well, because a
 * `disabled` is a statement about a pixel.
 *
 * `landing` is the other question, and Create is the one control that asks it:
 * not "is a capture in hand" but "is one still being WRITTEN to this device",
 * which is what makes releasing its audio unsafe. Keying Create on in-hand would
 * wedge the only control that can put a capture down.
 *
 * **The teardown is not optional.** A client-side navigation away from
 * /meetings used to leave the `MediaRecorder` running with the microphone open,
 * writing chunks through a closure, while the remounted page had a fresh empty
 * guard — so the live session appeared in the recovery offer, could be
 * discarded, and could not be stopped: `recorderRef` was null, `recording` was
 * false, the button said "Record", and pressing it started a SECOND concurrent
 * recorder over a second session while the first kept writing. `dispose()` is
 * that teardown, and it is why this object is created once per mount and handed
 * back on unmount.
 */
import {
  appendSegment,
  beginTranscriptFold,
  createCaptureSession,
  discardCapture as discardCaptureSession,
  drainWakeDelayMs,
  EMPTY_TRANSCRIPT_FOLD,
  finalizeCapture,
  foldTranscript,
  reconcileCaptureDraft,
  settleTranscriptForSubmit,
  stopCapture,
  unsettledSegments,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingDrainPhase,
  type MeetingTranscriptionQueue,
  type TranscriptFold,
} from "@kinqs/brainrouter-core/meetings";

import {
  captureHeldNote,
  CAPTURE_DISCARD_UNKNOWN,
  CAPTURE_LOCKS_UNAVAILABLE,
  CAPTURE_PICK_UP_UNKNOWN,
  CAPTURE_RECORDING_ELSEWHERE,
  type CaptureLocks,
} from "../../lib/meetings/captureLock";
import {
  parseCapturePayload,
  resumableCaptures,
  serializeCapturePayload,
  type ResumableCapture,
} from "../../lib/meetings/capturePayload";
import { createCaptureQueue, DEFAULT_CAPTURE_MIME_TYPE, type SegmentTranscriber } from "../../lib/meetings/captureQueue";
import { newCaptureSessionId, type CaptureChunkRef } from "../../lib/meetings/captureStorage";
import { MEETING_CAPTURE_TIMESLICE_MS, type CaptureSessionRecord, type MeetingCaptureStore } from "../../lib/meetings/captureStore";
import {
  clearMeetingDraft,
  isEmptyMeetingDraft,
  MEETING_DRAFT_CAPTURE_ID,
  readMeetingDraft,
  takeLegacyMeetingDraft,
  writeMeetingDraft,
  type LegacyDraftStorage,
  type MeetingDraft,
} from "../../lib/meetings/meetingDraft";
import { captureFallbackNotice, type OpenedCaptureStore } from "../../lib/meetings/openCaptureStore";
import { isStorageQuotaError } from "../../lib/meetings/storageBudget";

export const CAPTURE_TEMPLATES: readonly MeetingCaptureTemplate[] = ["general", "standup", "one-on-one", "retrospective"];

/**
 * The picker's value as the shared model's template.
 *
 * The two vocabularies are deliberately the same list, so this is a narrowing
 * rather than a mapping — but it is a narrowing that has to exist, because a
 * select's value is a string and `createCaptureSession` would take a
 * meaningless one silently.
 */
export function captureTemplate(value: string): MeetingCaptureTemplate {
  return CAPTURE_TEMPLATES.find((template) => template === value) ?? "general";
}

/**
 * The opening of the reap's own warning, so a later success can retract exactly
 * that sentence and nothing else in the same slot.
 */
export const REAP_WARNING = "Recordings this device can no longer account for were not cleaned up — ";

/**
 * ADR-035 D1b — the recording in progress. `bytes` and `startedMs` are here and
 * not in the published state on purpose: they feed the storage-budget projection
 * on every chunk, and a re-render per chunk is not a reason to re-render a page
 * showing a meeting library.
 */
interface ActiveCapture {
  readonly store: MeetingCaptureStore;
  readonly sessionId: string;
  readonly startedMs: number;
  readonly mimeType: string;
  bytes: number;
  /**
   * When the previous chunk landed. A segment's duration is measured rather than
   * assumed to be the timeslice: `MediaRecorder` pauses, the tab is backgrounded,
   * and the last chunk of a meeting is always short — and these numbers are what
   * D5 prints in a gap marker, so a guessed one misreports where the hole is.
   */
  lastChunkMs: number;
}

/**
 * ADR-035 D6 — a meeting that was created but whose audio could not be released.
 *
 * Kept as its own list, and rendered outside the compose dialog, because the
 * failure happens in the same commit that closes it: the meeting succeeded, the
 * bytes are still here, and a message inside a form that is about to unmount can
 * never be read.
 */
export interface RetainedAudio {
  readonly sessionId: string;
  readonly message: string;
}

/**
 * §6 — "the audio up to the kill must be on disk AND PLAYABLE".
 *
 * A recovered meeting whose transcript comes back but whose recording can never
 * be heard satisfies half of the destructive test. `url` is an object URL over
 * what the store reassembled, so it is revoked on the way out; `missing` is how
 * many chunks the store could not read, because a player that silently skips
 * them is the "quietly wrong" failure D5 rules out one layer up.
 */
export interface CapturePreview {
  readonly sessionId: string;
  readonly url: string;
  readonly missing: number;
}

/** The one recorder fact this module needs, so a test does not have to be a browser. */
export interface CaptureRecorder {
  readonly mimeType: string;
  readonly state: "inactive" | "recording" | "paused";
  start(timesliceMs: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

/**
 * A recorder AND the microphone behind it, together.
 *
 * One port rather than two because the pair has one invariant: a recorder that
 * never started leaves the stream live and `onstop` never fires, so the tracks
 * have to be stopped by hand or the microphone light stays on with nothing
 * recording it. Handing back a `release` beside the recorder is what makes that
 * impossible to forget.
 */
export interface CaptureMicrophone {
  readonly recorder: CaptureRecorder;
  release(): void;
}

export interface CreateMeetingInput {
  readonly title: string;
  readonly transcript: string;
  readonly template: string;
  /**
   * The workspace the meeting lands in — open question 5's answer, computed
   * HERE from the session's frozen scope rather than read from the switcher at
   * the moment of the click.
   */
  readonly orgId: string | null;
}

export interface CaptureSurfacePorts {
  /**
   * THIS tab's Web Locks (`captureLock.ts`) — the authority on which captures a
   * tab of this origin is writing to. One per surface: the handles it holds are
   * what "that one is mine" means, so a shared instance would make two tabs read
   * each other's recordings as their own.
   */
  readonly locks: CaptureLocks;
  openStore(requestPersistence: boolean): Promise<OpenedCaptureStore>;
  /** The switcher's CURRENT workspace. Read at Record, and never again for that recording. */
  activeOrgId(): string;
  openMicrophone(): Promise<CaptureMicrophone>;
  createTranscriber(language: string | undefined): SegmentTranscriber;
  createMeeting(input: CreateMeetingInput): Promise<{ readonly id: string }>;
  /** D8 — the import path, which really can be handed an hour of audio in one piece. */
  transcribeFile(blob: Blob, language: string): Promise<string>;
  legacyDraftStorage(): LegacyDraftStorage | null;
  confirm(question: string): boolean;
  now(): number;
  setTimer(run: () => void, ms: number): number;
  clearTimer(handle: number): void;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  warn(message: string, detail?: unknown): void;
  /** Whether the page is running something of its own — the submit guard reads it. */
  otherBusy(): boolean;
  onCreated(meetingId: string): void;
}

export type CaptureBusy = "" | "transcribe" | "preview" | "create";

/**
 * Which control is part-way through taking a capture into this tab's hands, in
 * the window before there is a queue to see it by. `""` is neither.
 */
type CaptureClaim = "" | "record" | "pick-up";

export interface CaptureSurfaceState {
  readonly createOpen: boolean;
  readonly title: string;
  readonly transcript: string;
  readonly language: string;
  readonly template: string;
  readonly draftRecovered: boolean;
  readonly draftReady: boolean;
  readonly recording: boolean;
  readonly paused: boolean;
  /**
   * The window between `stop()` and the capture being settled — `recording` is
   * already false across it while the final chunk is still being written and has
   * no segment yet.
   */
  readonly settling: boolean;
  /**
   * Whether a capture is IN THIS TAB'S HANDS — the ONE predicate every control
   * that can start or adopt one is disabled by, published so a button cannot say
   * something the function will not do.
   *
   * In hand runs from the press of Record or Pick up until the capture is FILED:
   * the meeting created, or the recording discarded. Stop does not end it, the
   * settle does not end it, and closing the dialog does not end it — the compose
   * box still holds that meeting's transcript through all three, so a second
   * capture started or adopted in any of them is folded into the same box and
   * posted as one meeting.
   *
   * Neither `recording` nor the narrower `landing` is this predicate. `recording`
   * is false for the whole arming window — `openStore(true)`, `store.begin`, then
   * `getUserMedia`, two of which are permission prompts a person can leave on
   * screen — while a lock, a session record and a live queue already exist.
   * `landing` covers that window and the settle, and then stops one tick after
   * the last chunk lands, which is where the merge above happens.
   *
   * Derived in `#patch` from the same facts `record` and `pickUp` read directly,
   * because one of them is a private field no patch can carry and a second copy
   * of this answer is how they come apart.
   */
  readonly capturing: boolean;
  /**
   * Whether a capture is still being WRITTEN to this device — arming, recording,
   * or a settle that has not finished putting the last chunk down.
   *
   * The question Create asks, and the only one it may ask. Creating a meeting
   * releases the capture's audio, so it has to wait for the bytes to land; it
   * must NOT wait for the capture to leave this tab's hands, because pressing
   * Create is one of the two things that takes it out of them.
   */
  readonly landing: boolean;
  /** A READING: which store, how much room. Rewritten by every chunk. */
  readonly notice: string;
  /** An EVENT that is still true: a failed persist, a full store, a refused write. */
  readonly warning: string;
  /**
   * Golden rule 23 — the standing sentence for a browser that cannot answer "is
   * another tab writing to this?" at all, and `""` for one that can.
   *
   * Its own slot rather than the warning's, because it is a PROPERTY OF THIS
   * BROWSER for the whole page view: it must not be cleared by the next event,
   * and it must not clear one. Without it the degradation is invisible, which is
   * the definition of a silent outage.
   */
  readonly coordination: string;
  /**
   * The captures some tab of this origin is writing to, as of the last check.
   *
   * Published so the offer's controls can say what the functions will refuse.
   * The functions ask again, authoritatively, at the moment of the click — this
   * is a rendering, and a rendering is always slightly old.
   */
  readonly writing: readonly string[];
  /**
   * Whether the last check could ANSWER "which captures is some tab of this
   * browser writing to?" at all.
   *
   * A property of the last reading rather than of the browser, because a lock
   * service can also refuse one query and answer the next. `false` is what the
   * offer's Discard carries in its TOOLTIP (golden rule 23: say so, rather than
   * silently behaving differently) — and deliberately not what it is disabled
   * by, because the offer's row is the only place a Discard is rendered and
   * disabling it there is audio nobody can remove from their own device.
   * `discard` puts that same sentence to the person as a question, which is the
   * answer that actually decides.
   */
  readonly writersKnown: boolean;
  readonly createError: string;
  readonly busy: CaptureBusy;
  readonly session: MeetingCaptureSession | null;
  readonly phase: MeetingDrainPhase | null;
  readonly retrying: number | null;
  readonly recoverable: readonly ResumableCapture[];
  readonly recoveryError: string;
  readonly retained: readonly RetainedAudio[];
  readonly preview: CapturePreview | null;
}

const EMPTY_STATE: CaptureSurfaceState = {
  createOpen: false,
  title: "",
  transcript: "",
  language: "auto",
  template: "general",
  draftRecovered: false,
  draftReady: false,
  recording: false,
  paused: false,
  settling: false,
  capturing: false,
  landing: false,
  notice: "",
  warning: "",
  coordination: "",
  writing: [],
  writersKnown: true,
  createError: "",
  busy: "",
  session: null,
  phase: null,
  retrying: null,
  recoverable: [],
  recoveryError: "",
  retained: [],
  preview: null,
};

/** How long a keystroke waits before the draft is written down. */
const DRAFT_SAVE_DELAY_MS = 250;

/**
 * What a discard asks when this browser CAN say nobody else is writing —
 * `CAPTURE_DISCARD_UNKNOWN` is the same question on a browser that cannot, and
 * the difference between the two sentences is the whole of what the person is
 * being asked to decide.
 */
const DISCARD_QUESTION = "Discard this unfinished recording? Its audio is deleted from this device.";

/**
 * And what it asks about the capture THIS TAB is holding, which is a different
 * question because the compose box in front of the person is that capture's.
 *
 * A discard that left the words behind would be the merge arriving one step
 * later: the next recording folds into a box that still holds the meeting just
 * thrown away, and Create posts both as one. So the box goes with the audio, and
 * the sentence says so before anything is deleted.
 */
const DISCARD_HELD_QUESTION =
  "Discard this recording? Its audio is deleted from this device, and the title and transcript in this box are cleared with it.";

/** An error's own words when it has any, and a plain sentence when it does not. */
export function describe(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message.trim() : "";
  return message || fallback;
}

/**
 * Whether the capture ON THE DEVICE still says a microphone is open on it —
 * which of `captureHeldNote`'s two sentences another tab's lock deserves.
 *
 * Read from the record's payload rather than from a restored session, because
 * recovery rewrites `recording` → `stopped` by design: nothing is recording a
 * capture that came back out of storage, so a restored copy can never answer
 * this question and would call every live recording "open".
 */
export function storedStillRecording(record: CaptureSessionRecord): boolean {
  return parseCapturePayload(record.payload).session?.status === "recording";
}

export class MeetingCaptureSurface {
  readonly #ports: CaptureSurfacePorts;

  #state: CaptureSurfaceState = EMPTY_STATE;

  readonly #listeners = new Set<() => void>();

  #opened: OpenedCaptureStore | null = null;

  #opening: Promise<OpenedCaptureStore> | null = null;

  /**
   * The recording being WRITTEN — what `landing` is mostly made of, and the one
   * `dispose` stops.
   *
   * It outlives `recording` at both ends: it is set before the recorder starts
   * and cleared only when the settle has finished writing. That is exactly the
   * span in which releasing the capture's audio would strand a chunk, and it is
   * NOT the span a start or an adoption is refused across — `#finishCapture`
   * clears this the instant the last chunk lands, while the meeting it belongs
   * to is still in the box and still unfiled. Written through `#setActive` so
   * the published copy moves with it.
   */
  #active: ActiveCapture | null = null;

  #recorder: CaptureRecorder | null = null;

  #microphone: CaptureMicrophone | null = null;

  /**
   * Which control is in the middle of TAKING a capture into this tab's hands,
   * and `""` when neither is — the half of "in hand" that exists before there is
   * a queue to see.
   *
   * Both controls need it and for the same reason. `record()` spends the window
   * in front of two permission prompts with a lock and a session record already
   * taken; `pickUp()` marked NOTHING at all while it ran, so a Record pressed
   * inside its awaits saw an idle tab, started, and was then handed straight
   * back by `#attachQueue` releasing what it thought was the previous capture's
   * lock. One value closes both orderings rather than a flag per caller.
   *
   * It is a name and not a boolean because the refusal has to say which window
   * the person is in — ADR-028 — and that is the only thing the extra
   * information is used for. Written through `#setClaiming` for the same reason
   * `#active` is: a private field cannot ride along on a patch, and the buttons
   * read the published copy.
   */
  #claiming: CaptureClaim = "";

  /**
   * One per meeting, the SINGLE WRITER of its session while it exists — and the
   * other half of "in hand".
   *
   * It is set by `#attachQueue` and dropped by `#release` and by nothing else,
   * which is what makes "filed" a fact rather than a convention: `#release` runs
   * on a create that succeeded and on a discard, so a capture stops being this
   * tab's exactly when the meeting exists on the server or its audio has been
   * thrown away.
   */
  #queue: MeetingTranscriptionQueue | null = null;

  /**
   * The capture this tab has stopped RECORDING and will hand back as soon as it
   * has finished writing to it — see `#handBackIfQuiet`.
   */
  #handingBack: string | null = null;

  #wake: number | null = null;

  #draftSave: number | null = null;

  /**
   * D4 — how much of this capture's transcript is already in the box, and the
   * exact string it holds for each segment. The shared fold's resume point, and
   * RECONSTRUCTIBLE: `#attachQueue` rebuilds it from the restored box, which is
   * the whole reason the resume point is a fold and not the `dirty` keystroke
   * flag it replaced.
   */
  #fold: TranscriptFold = EMPTY_TRANSCRIPT_FOLD;

  #previewRef: { readonly sessionId: string; readonly url: string } | null = null;

  /** The settle in flight, so `dispose` can wait for the recording to finish landing. */
  #finishing: Promise<void> | null = null;

  #disposed = false;

  /**
   * Which attempt to start a recording is the current one.
   *
   * Bumped by `dispose()`, and compared by `record()` across each of its awaits.
   * The flag above cannot do this job: `dispose()` sets it permanently, and this
   * object OUTLIVES a teardown — React 19's StrictMode runs
   * mount → cleanup → mount on the committed instance, and Next turns StrictMode
   * on for the App Router by default. So a `record()` that latched on `#disposed`
   * was dead for the rest of the page's life in `next dev`: 0 store opens, 0
   * microphone prompts, no session, and an empty `createError` — a dead button
   * with no message, which is ADR-028's own complaint. What is cancelled is one
   * ATTEMPT, exactly as `MeetingCaptureRecorder.attempt` cancels one on the
   * desktop, so a teardown still abandons the arming in flight and the next mount
   * can still record.
   */
  #attempt = 0;

  constructor(ports: CaptureSurfacePorts) {
    this.#ports = ports;
    // Golden rule 23, raised before anything is recorded rather than at the
    // moment it costs somebody a meeting: whether this browser can see other
    // tabs at all is known from the first line, and a degradation nobody is told
    // about is indistinguishable from working.
    if (!ports.locks.available) this.#state = { ...this.#state, coordination: CAPTURE_LOCKS_UNAVAILABLE };
  }

  // ————————————————————————————————————————————————————————— the React seam

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): CaptureSurfaceState => this.#state;

  // ——————————————————————————————————————————————————————————— the compose box

  setTitle(title: string): void {
    this.#patch({ title });
    this.#scheduleDraftSave();
  }

  setTranscript(transcript: string): void {
    this.#patch({ transcript });
    // The fold runs on every keystroke as well as every drain, which is
    // deliberate and cheap: with nothing new settled it reports `changed: false`
    // and does nothing at all.
    this.#compose();
    this.#scheduleDraftSave();
  }

  setLanguage(language: string): void {
    this.#patch({ language });
    this.#scheduleDraftSave();
  }

  setTemplate(template: string): void {
    this.#patch({ template });
    this.#scheduleDraftSave();
  }

  openDialog(): void {
    this.#patch({ createOpen: true, createError: "" });
  }

  closeDialog(): void {
    this.#patch({ createOpen: false });
    // The player is rendered inside the dialog and nowhere else, so a closed one
    // leaves an object URL over a WHOLE meeting's audio that nothing can show
    // and nothing will revoke — an hour of WebM pinned in the tab's heap, which
    // is the exact thing D1 stopped doing on the write side.
    this.#revokePreview();
  }

  /** ADR-028 — how many segments would go in as stated gaps if Create were pressed now. */
  get unresolved(): number {
    return this.#state.session ? unsettledSegments(this.#state.session).length : 0;
  }

  // ——————————————————————————————————————————————————————————————— the draft

  /**
   * D6 — the draft comes back from the protected store, and the copy in
   * `localStorage` is taken OUT of it on the way past.
   *
   * `takeLegacyMeetingDraft` removes as it reads, because a migration that
   * leaves the original where it was has not moved anything — it has made a
   * second copy of the thing the decision is about.
   */
  async init(): Promise<void> {
    // This mount is live, whatever the last one did. React 19's StrictMode runs
    // mount → cleanup → mount on the COMMITTED object — `init#1 → dispose#1 →
    // init#1`, proved with react-test-renderer — and Next turns StrictMode on
    // for the App Router by default, which this dashboard does not override. So
    // without this line every teardown flag `dispose()` set was still set on the
    // object the page went on using: `draftReady` stayed false (the guard below
    // returns before it is patched), so the compose draft was never persisted,
    // and `#scheduleDraftSave` refused every keystroke after it. A page that
    // cannot save a draft in the environment it is developed in is a page whose
    // draft has not been tested.
    this.#disposed = false;
    let draft: MeetingDraft | null = null;
    try {
      const storage = this.#ports.legacyDraftStorage();
      if (storage) draft = takeLegacyMeetingDraft(storage);
    } catch {
      // A storage that will not answer is not a reason to fail this page.
    }
    try {
      const store = await this.#store(false);
      if (draft) await writeMeetingDraft(store, draft);
      else {
        const stored = await readMeetingDraft(store);
        draft = isEmptyMeetingDraft(stored) ? null : stored;
      }
    } catch {
      // No durable store here; there is simply no draft to restore.
    }
    if (this.#disposed) return;
    // Into an EMPTY box, and only into an empty box. A remount is not a fresh
    // page: StrictMode hands this the SAME object, so this can run over a
    // compose box that already holds what the person typed — and what it has
    // just read back is the older copy, because the teardown's own
    // `#flushDraftSave` is still in flight behind it. Reproduced in `next dev`:
    // type, remount, and the box reverts to the previous save with no error
    // anywhere, after which the next keystroke writes the reverted text down for
    // good. The stored draft exists to fill a box nobody has typed in; it is
    // never the authority over one somebody is looking at.
    const box: MeetingDraft = {
      title: this.#state.title,
      transcript: this.#state.transcript,
      language: this.#state.language,
      template: this.#state.template,
    };
    if (draft && isEmptyMeetingDraft(box)) {
      this.#patch({
        ...(draft.title ? { title: draft.title } : {}),
        ...(draft.transcript ? { transcript: draft.transcript } : {}),
        ...(draft.language ? { language: draft.language } : {}),
        ...(draft.template ? { template: draft.template } : {}),
        draftRecovered: true,
      });
    }
    // Set last, and on the failure path too: it is what unblocks the save, and a
    // save that ran first would write an empty draft over the one still being read.
    this.#patch({ draftReady: true });
  }

  // ————————————————————————————————————————————————————————————— recording

  /**
   * Is a capture IN THIS TAB'S HANDS — the rule for every path that starts or
   * adopts one, and the reason none of them may read `recording` or `landing`.
   *
   * A capture is in hand from the press until it is FILED, and filed has exactly
   * two spellings in this file: `#release(true)` behind a create that reached
   * the server, and `#release(false)` behind a discard. Both drop `#queue`, and
   * nothing else does — so Stop, the settle and a closed dialog all leave the
   * capture here, which is the truth the person can see, because the compose box
   * still has that meeting's transcript in it.
   *
   * That is what makes the two facts below the whole answer. `#claiming` covers
   * the stretch before a queue exists — two permission prompts on the `record`
   * side, a store open and a lock acquisition on the `pickUp` side — and
   * `#queue` covers everything after it. Between them there is no instant in
   * which this tab holds a meeting and answers that it does not.
   */
  get #captureInHand(): boolean {
    return this.#claiming !== "" || this.#queue !== null;
  }

  /**
   * Is a capture still being WRITTEN to this device — the narrower question, and
   * `submit`'s alone.
   *
   * Create releases the capture's audio, so it must wait for the bytes: the
   * arming window (a lock and a session record already exist), the recording,
   * and the settle in which `#active` outlives `recording` while the last chunk
   * lands. It must NOT wait for the capture to leave this tab's hands, because
   * pressing Create is one of the two things that takes it out of them — keying
   * it on `#captureInHand` would wedge the only control that can put one down.
   */
  get #captureLanding(): boolean {
    return this.#claiming !== "" || this.#state.recording || this.#active !== null;
  }

  /** Name the control that is taking a capture, or `""`, AND republish. */
  #setClaiming(claiming: CaptureClaim): void {
    this.#claiming = claiming;
    this.#patch({});
  }

  /**
   * Why a start or an adoption is being refused, in the words of whatever is
   * actually in hand — five states, and the person is in exactly one of them.
   *
   * The caller supplies the consequence, because that is the only part that
   * differs between starting a second capture and adopting one.
   */
  #inHandNote(consequence: string): string {
    const because = this.#claiming === "record"
      ? "This recording is still starting: this browser has not finished answering the storage and microphone prompts."
      : this.#claiming === "pick-up"
        ? "A saved recording is still being opened in this tab."
        : this.#state.recording
          ? "This meeting is already being recorded — press ■ Stop recording to finish it."
          : this.#active
            ? "The end of this recording is still being written to this device. This takes a moment."
            : "This recording has not been created or discarded yet, and its transcript is still in the box.";
    return `${because} ${consequence}`;
  }

  /** Take a recording into this tab's hands, or let go of it, and republish. */
  #setActive(capture: ActiveCapture | null): void {
    this.#active = capture;
    this.#patch({});
  }

  /**
   * D2 — pressing Record creates the session, and the LOCK over it is taken
   * before the session record exists and therefore before the microphone is
   * asked for.
   *
   * That order is the whole of defect C, and it is the one thing the heartbeat
   * this replaced could not do. The beat was started here too, but it wrote
   * nothing until `#queue` existed — which is after `openMicrophone()` resolves
   * — so for the entire length of the permission prompt the record said nobody
   * was writing. Measured: after 35 seconds a second tab's ordinary refresh
   * REAPED the session, and the chunk that arrived when the person finally
   * clicked Allow landed into a meeting that no longer existed. A lock has no
   * such hole: it is held from this line, by the browser, whether or not this
   * tab ever gets a microphone, and it is released the instant the tab dies.
   *
   * **And this path is cancellable, in three places.** `dispose()` can only stop
   * a recorder that already EXISTS, and the stretch in front of two permission
   * prompts is exactly the one where none does yet — so the teardown is asked
   * about before each prompt and once more before the recorder starts. Not after
   * every await: the checks in between were undone by the ones after them, and a
   * guard whose removal changes nothing observable is a guard nobody can keep
   * honest. The three that are left each stop something different, and
   * `#abandonArming` says what each cost when it was missing.
   *
   * What those three compare is `#attempt` and not `#disposed`, because a
   * teardown cancels THIS start and not the object: see the field, and the
   * StrictMode remount that made a permanently latched flag a dead Record button
   * in `next dev`.
   */
  async record(): Promise<void> {
    // 1/3 — a press that lands after the teardown, on a page with no mount after
    // it. Below this line is `openStore(true)`, which asks the browser for
    // persistent storage: a permission prompt raised by a page the person has
    // already left. This one is the flag, because there is no attempt yet to
    // compare — `init()` clears it, so a remounted page records normally.
    if (this.#disposed) return;
    // REPRODUCED twice, at the two ends of a capture's life in this tab.
    //
    // During the arming stretch it is the ordinary "nothing happened, click it
    // again": `recording` is false and the button was disabled by nothing but
    // `busy`, so a second press started a SECOND recorder over a SECOND session.
    // `#attachQueue` handed the first capture's lock back as the "previous"
    // queue and `#recorder`/`#active` then pointed only at the second — so
    // `stop()` stopped only the second, `dispose()` could not reach the first
    // either, and the first went on recording with the microphone open while
    // THIS tab offered it back in its own recovery list with `writersKnown:
    // true` beside a Discard that would delete the audio its recorder was still
    // appending to.
    //
    // One tick after Stop it is quieter and just as expensive: the settle has
    // landed, so an "in flight" guard is already false, and the box in front of
    // the person still holds the meeting they have not filed. The new recording
    // folds its words into the same box under the same title, and Create posts
    // two meetings as one.
    //
    // In the FUNCTION as well as on the button, because a `disabled` is a
    // statement about a pixel and this one starts a microphone.
    if (this.#captureInHand) {
      this.#patch({
        createError: this.#inHandNote(
          "Starting a second one now would leave this tab holding two meetings: the first with nothing claiming what it writes, and both of their transcripts folded into the one box below, which Create would post as a single meeting.",
        ),
      });
      return;
    }
    const attempt = this.#attempt;
    this.#patch({ createError: "", warning: "" });
    // Raised before the first await and lowered only once the recorder is
    // running (or has failed to start). `recording` cannot cover this stretch:
    // it is set at the very end, and by then the queue has existed — and been
    // the single writer of a real session — for two awaits.
    this.#setClaiming("record");
    const title = this.#state.title.trim();
    const startedMs = this.#ports.now();
    const startedAt = new Date(startedMs).toISOString();
    let store: MeetingCaptureStore;
    let sessionId: string;
    let session: MeetingCaptureSession;
    /** The lock to hand back if anything below fails; `""` while there is none. */
    let held = "";
    try {
      store = await this.#store(true);
      sessionId = newCaptureSessionId();
      // Before `begin`, and so before `getUserMedia`. A fresh id cannot already
      // be taken, so the refusal is unreachable rather than impossible — and an
      // unreachable branch that says what it means beats one that assumes.
      if (await this.#ports.locks.hold(sessionId) === "taken") throw new Error(CAPTURE_RECORDING_ELSEWHERE);
      held = sessionId;
      // Open question 5 — the org is frozen HERE, at Record. Nothing rewrites a
      // session's scope afterwards, so a recording that started under one
      // organization cannot silently land in another when the switcher moves.
      session = createCaptureSession({
        id: sessionId,
        startedAt,
        scope: { orgId: this.#ports.activeOrgId() || null },
        title,
        template: captureTemplate(this.#state.template),
        ...(this.#state.language === "auto" ? {} : { language: this.#state.language }),
      });
      await store.begin({ sessionId, startedAt, payload: serializeCapturePayload({ ...(title ? { title } : {}), session }) });
      // 2/3 — the last line before `getUserMedia`. A microphone prompt is not
      // something to raise on a page the person has left, and the lock and the
      // record taken above go back with this: it is the ordering that used to
      // leave a lock nothing would ever release.
      if (this.#attempt !== attempt) {
        await this.#abandonArming(store, sessionId);
        return;
      }
    } catch (caught) {
      this.#setClaiming("");
      if (held) this.#ports.locks.release(held);
      this.#patch({ createError: describe(caught, "This browser cannot store a recording durably.") });
      return;
    }
    let microphone: CaptureMicrophone | undefined;
    try {
      microphone = await this.#ports.openMicrophone();
      const recordingMs = this.#ports.now();
      const capture: ActiveCapture = {
        store,
        sessionId,
        startedMs: recordingMs,
        lastChunkMs: recordingMs,
        mimeType: microphone.recorder.mimeType || DEFAULT_CAPTURE_MIME_TYPE,
        bytes: 0,
      };
      this.#setActive(capture);
      const queue = this.#attachQueue(store, session, { mimeType: capture.mimeType, title, base: this.#state.transcript });
      // Awaited, and before the first chunk: this is the write that puts the
      // recorder's container type in the manifest, and recovery reads the audio
      // back with it. It goes through `apply` because the queue is the single
      // writer.
      try {
        await queue.apply((current) => current);
      } catch (caught) {
        // The audio itself is unaffected, so this warns rather than refuses: a
        // recording with an unrecorded format beats no recording.
        this.#patch({ warning: `This recording's details could not be saved (${describe(caught, "unknown error")}). If it has to be recovered later it will be read back as WebM.` });
      }
      // 3/3 — the last await before the recorder starts, and the worst one to
      // be missing: past this line `dispose()` has a recorder to stop, before it
      // a `start()` runs on a page that has gone, writing chunks through a
      // closure nothing can reach and holding the microphone open. It covers the
      // prompt the person answered on their way out, too.
      if (this.#attempt !== attempt) {
        await this.#abandonArming(store, sessionId, microphone);
        return;
      }
      const recorder = microphone.recorder;
      const opened = microphone;
      recorder.ondataavailable = (event) => {
        if (event.data.size) void this.#persistChunk(capture, event.data);
      };
      recorder.onstop = () => {
        opened.release();
        this.#finishing = this.#finishCapture(capture);
        void this.#finishing;
      };
      this.#recorder = recorder;
      this.#microphone = opened;
      // D1 — an explicit timeslice. Without one MediaRecorder may hand over a
      // single blob at the end, and writing it down then buys nothing.
      recorder.start(MEETING_CAPTURE_TIMESLICE_MS);
      this.#setClaiming("");
      this.#patch({ recording: true, paused: false });
    } catch {
      // A microphone that was refused, or a recorder that would not start — the
      // second of which leaves the stream live with `onstop` never running, so
      // the teardown below is what stops the microphone light.
      await this.#abandonArming(store, sessionId, microphone);
      this.#patch({ createError: "Microphone access was denied or is unavailable." });
    }
  }

  /**
   * A recording that was being armed and now must not exist: nothing running,
   * nothing held, nothing half-claimed.
   *
   * Two callers, one shape. The microphone was refused (or the recorder would
   * not start), or the page went away while `record()` was still waiting on an
   * `await` — and the second is the one `dispose()` structurally cannot cover,
   * because it only knows how to stop a recorder that already exists. All three
   * orderings were reproduced and each lost something different:
   *
   * - **teardown after the lock, before the recorder** — `releaseAll()` handed
   *   the lock back and the recording ran holding NOTHING, so a second tab was
   *   offered the live meeting and its Discard was not refused;
   * - **teardown before the first chunk** — that same lock-less manifest was
   *   REAPED by the next tab's ordinary mount refresh, and the recorder appended
   *   into a session that no longer existed;
   * - **teardown BEFORE the lock is taken** — the common ordering, since
   *   `dispose()` runs synchronously to its end when there is no recorder yet:
   *   the lock was acquired after `releaseAll()` and nothing would ever release
   *   it, so every tab read that capture as being recorded, permanently
   *   un-offerable and undeletable.
   *
   * The record goes with it. The recorder never started, so there is no audio to
   * lose — and a chunk-less manifest left behind is only reclaimable by a reap
   * that can prove nobody is writing to it, which a browser without Web Locks
   * cannot do at all.
   */
  async #abandonArming(store: MeetingCaptureStore, sessionId: string, microphone?: CaptureMicrophone): Promise<void> {
    this.#setClaiming("");
    microphone?.release();
    this.#ports.locks.release(sessionId);
    if (this.#recorder === microphone?.recorder) this.#recorder = null;
    if (this.#microphone === microphone) this.#microphone = null;
    // Only if this recording got as far as HAVING a queue: the first of the
    // three checkpoints runs before `#attachQueue`, so there is nothing to tear
    // down there, and the id is compared rather than assumed because a queue
    // that is not this session's is not this abandon's to drop. Leaking one is
    // permanent: the queue is half of "in hand", so Record and Pick up would
    // both stay refused for a meeting that was deleted two lines below, and
    // there is no capture left for a discard to file.
    if (this.#queue?.session.id === sessionId) {
      this.#queue = null;
      this.#cancelWake();
      this.#patch({ session: null, phase: null, retrying: null });
    }
    if (this.#active?.sessionId === sessionId) this.#setActive(null);
    await store.delete(sessionId).catch(() => {});
  }

  stop(): void {
    this.#recorder?.stop();
    this.#recorder = null;
    this.#patch({ recording: false, paused: false });
  }

  togglePause(): void {
    const recorder = this.#recorder;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      this.#patch({ paused: true });
    } else if (recorder.state === "paused") {
      recorder.resume();
      this.#patch({ paused: false });
    }
  }

  /**
   * ADR-035 D1/D3 — the chunk becomes bytes before it becomes anything else,
   * then a segment, then work for the queue.
   *
   * **Nothing is asked before the write.** There used to be a heartbeat here,
   * and with it a rule about what to do when this tab could no longer tell
   * whether it still held the recording. Neither is needed now and neither is
   * safe to reintroduce: a lock cannot be taken from a tab that holds it, so
   * while this handler is running nobody else is writing to this capture —
   * there is no zombie case to detect. `appendChunk` is the first statement
   * again, which also restores the property the beat quietly broke: the write
   * joins the store's queue synchronously, before Stop can settle around it.
   *
   * **Keep it first.** That ordering is the entire reason `#finishCapture` can
   * settle a meeting by draining the store alone. Put any await in front of it
   * and the final chunk is no longer in the queue Stop waits on: that is how a
   * meeting came to be settled without its ending, and nothing above this line
   * will say so.
   *
   * Three steps, three separate failures, and they are NOT the same news. One
   * `try` around all three wrote one sentence for all of them — "that audio is
   * missing from the meeting" — which is true of the first and false of the
   * other two.
   */
  async #persistChunk(capture: ActiveCapture, data: Blob): Promise<void> {
    // Stopping is the same response to "the store is full" whichever write
    // discovered it: the surface must stop offering "■ Stop recording" while
    // every remaining chunk is refused.
    const stopIfFull = async (caught: unknown): Promise<void> => {
      if (!(await this.#captureIsFull(capture, caught))) return;
      this.#patch({ warning: "Storage for this site is full. Recording stopped so the audio already saved stays intact." });
      this.stop();
    };
    let chunk: CaptureChunkRef;
    try {
      chunk = await capture.store.appendChunk(capture.sessionId, data);
    } catch (caught) {
      // The one failure that really does lose audio, and the STICKY slot: the
      // dialog's own error slot renders only inside a dialog the × and the scrim
      // close WITHOUT stopping the recording, and `submit` clears it — so the
      // one statement that part of the recording was never written was erased at
      // the exact moment the user committed and the audio was deleted.
      this.#patch({ warning: `A piece of this recording could not be saved on this device — ${describe(caught, "the capture store refused the write.")} That audio is missing from the meeting, and no segment was recorded for it, so the transcript cannot state it as a gap either.` });
      // The success path's `exhausted` guard never runs when the WRITE is what
      // failed — which is precisely when the store is full.
      await stopIfFull(caught);
      return;
    }
    capture.bytes += chunk.byteLength;
    const landedMs = this.#ports.now();
    const durationMs = Math.max(1, landedMs - capture.lastChunkMs);
    capture.lastChunkMs = landedMs;
    const queue = this.#queue;
    if (queue && queue.session.id === capture.sessionId) {
      try {
        // The index/sequence check is INSIDE the transition because `apply` is
        // serialized: reading the length outside it would race a concurrent
        // append. The queue's `readSegment(index)` port reads chunk `index`, so a
        // segment recorded at the wrong index would transcribe somebody else's
        // audio into plausible-looking text. An unclaimed chunk is the safe
        // failure — `restoreCaptureSession` adopts it on the next load.
        await queue.apply((session) => (
          session.status === "recording" && session.segments.length === chunk.sequence
            ? appendSegment(session, { byteLength: chunk.byteLength, durationMs })
            : session
        ));
        this.#publishSession(queue.session);
        void this.#runDrain();
      } catch (caught) {
        // The audio for this piece is on the device — `appendChunk` resolved —
        // and it is simply unclaimed, which is the safe failure the transition
        // above is written around.
        this.#patch({ warning: `This recording's progress could not be saved on this device — ${describe(caught, "the capture store refused the write.")} The audio itself IS saved; that piece is left unclaimed, and the next time this page loads it is adopted back into the recording.` });
        await stopIfFull(caught);
      }
    }
    try {
      const budget = await capture.store.budget({
        byteLength: capture.bytes,
        recordedMs: this.#ports.now() - capture.startedMs,
      });
      this.#patch({ notice: budget.message });
      // Out of space: stop while everything recorded so far is still readable.
      if (budget.level === "exhausted") this.stop();
    } catch {
      // A reading we could not take, and nothing more: the chunk is written and
      // the segment recorded. There is no loss here to report.
    }
  }

  /**
   * Stop pressed (or the store filled up): settle the capture, hand the
   * recording back, and let the queue carry on.
   *
   * **Create's guard is released as soon as the recording has landed, and not
   * one step later.** It used to be held across `await this.#runDrain()`, and a
   * drain runs until nothing is ready — through every retry of every failed
   * segment, and under D7 through an outage of any length. So long after the
   * final chunk was safely on the device, Create still refused with "The end of
   * this recording is still being written to this device", which by then was
   * simply untrue: the sentence names the last chunk, and the last chunk landed
   * at `settled()`. What the drain is doing afterwards is transcription, and a
   * segment that has not transcribed is what `unsettledSegments` already says
   * out loud and what `settleTranscriptForSubmit` states as a gap.
   *
   * That release is `landing`'s and `landing`'s alone. The capture is still in
   * this tab's HANDS when this returns — `#queue` is untouched here — because
   * the meeting is sitting in the compose box waiting to be created or thrown
   * away, and starting a second one over it is what merges two meetings.
   */
  async #finishCapture(capture: ActiveCapture): Promise<void> {
    this.#patch({ settling: true });
    try {
      // The final chunk arrives at `ondataavailable` and `onstop` fires straight
      // after it, so at this instant the last piece of the meeting is still on
      // its way to the store — and this is the line that waits for it. It is
      // enough BECAUSE `appendChunk` is the first thing `#persistChunk` does:
      // the write joins `#serialize` in the same turn the chunk was delivered
      // in, so every chunk the recorder has handed over is already in the queue
      // this drains, and the segment each one records is applied ahead of the
      // `stopCapture` below it. That is a property of the order of two lines,
      // not a law — a heartbeat inserted in front of `appendChunk` once broke it
      // and a meeting was settled without its ending, which is why `#persistChunk`
      // says so where the statement is.
      //
      // This used to be one of a PAIR, with a set of in-flight chunk handlers
      // awaited first and a comment claiming "either one alone settles the
      // meeting without its ending". That claim was false: each half was
      // individually deletable with the whole suite green, and on a backend
      // slowed to three ticks per write neither ordering could lose the ending.
      // A redundancy no test can tell apart from its absence is not a belt, so
      // it is gone rather than left with a sentence defending it.
      await capture.store.settled(capture.sessionId);
      const queue = this.#queue;
      if (!queue || queue.session.id !== capture.sessionId) return;
      // Ordered after the final chunk's own `apply` by the queue's write chain,
      // so `stopCapture` cannot land before the segment it belongs with.
      await queue.apply((session) => (session.status === "recording" ? stopCapture(session, this.#instant()) : session));
      // The recording is over, so this capture is on its way OUT of this tab's
      // hands — but it has not left them yet, and the lock does not go back
      // until it has. `#queue` is still the session's single writer and is
      // still draining: it persists every segment it settles and every gap it
      // gives up on. Releasing here (which this did) let a second tab pick the
      // capture up while those writes were still landing, which is two queues
      // over one capture — the state `pickUp` refuses in every other path,
      // reached through the one that was supposed to be safe.
      this.#handingBack = capture.sessionId;
      this.#publishSession(queue.session);
      if (!queue.session.segments.length) {
        this.#patch({ createError: "No audio was captured — check that the right microphone is selected." });
        await this.#release(false);
        return;
      }
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The recording could not be settled.") });
    } finally {
      // Identity-checked rather than cleared outright, and in the `finally` so
      // that a settle which THREW still lowers it — otherwise the failure that
      // stopped the meeting being finished would also wedge Create for good, and
      // Create is the press that gets the person out of it.
      if (this.#active === capture) this.#setActive(null);
      this.#patch({ settling: false });
    }
    // A meeting whose transcription is already finished — the common case, one
    // chunk or a hundred — leaves this tab's hands right here, exactly as it
    // used to. One that is not finished waits for the drain below.
    this.#handBackIfQuiet();
    await this.refreshRecoverable();
    // Transcription continues out here, with the Create guard released: the
    // audio is on the device and that guard's sentence has stopped being true.
    // Awaited rather than fired and forgotten so that `dispose()` — which waits
    // for this whole settle — gives a meeting one more transcription pass before
    // the page goes. The chunk that landed a moment ago has already scheduled a
    // drain of its own, so this is a second chance rather than the only one.
    await this.#runDrain();
  }

  /**
   * Hand a stopped recording back the moment this tab has finished writing to
   * it — the other half of `#handingBack`.
   *
   * "Finished" is not "the microphone is closed": the queue keeps persisting
   * this session until every segment has settled or spent its retry budget, and
   * a person can ask for a stated gap again from here. So the test is that
   * `unsettledSegments` is empty and no drain is scheduled — the same pair the
   * queue's own `idle` phase is defined by.
   *
   * Both alternatives are worse and both were tried. Holding until Create or
   * Discard keeps a finished meeting out of every other tab's offer for as long
   * as this one stays open on the compose box. Releasing at Stop hands it over
   * while this tab's queue is still persisting segments into it, which is two
   * queues over one capture. Releasing when the writing stops is the only rule
   * that is true at the moment it says so.
   */
  #handBackIfQuiet(): void {
    const sessionId = this.#handingBack;
    if (!sessionId) return;
    const queue = this.#queue;
    if (queue && queue.session.id === sessionId && unsettledSegments(queue.session).length) return;
    if (this.#wake !== null) return;
    this.#handingBack = null;
    this.#ports.locks.release(sessionId);
  }

  // ——————————————————————————————————————————————————————— the shared queue

  /**
   * ADR-035 D3/D5/D7 — run the shared queue once, then come back when it says to.
   *
   * Everything about WHICH segments run, how many at a time and when a retry is
   * due lives in the queue; this only turns its answer into a re-render and a
   * timer.
   */
  async #runDrain(force?: number): Promise<void> {
    const queue = this.#queue;
    if (!queue) return;
    this.#cancelWake();
    try {
      const result = force === undefined ? await queue.drain() : await queue.retry(force);
      // A newer capture replaced this one while the drain was in flight; its
      // session is the truth now.
      if (this.#queue !== queue) return;
      this.#publishSession(result.session);
      this.#patch({ phase: result.phase });
      // A persist that threw is a host about to lose the record of a meeting
      // whose audio is fine.
      if (result.errors.length) {
        this.#patch({ warning: `This recording's progress could not be saved on this device: ${result.errors[0]}` });
      }
      // The floor and the "is there anything to schedule at all" question are
      // one shared answer, because the queue can legitimately reply
      // `nextWakeMs: 0` and honouring a zero literally spins this timer against
      // a store that is already refusing it.
      const delay = drainWakeDelayMs(result.nextWakeMs);
      if (delay !== null) {
        this.#wake = this.#ports.setTimer(() => {
          this.#wake = null;
          void this.#runDrain();
        }, delay);
      }
      // Asked after the timer is (or is not) set, because "nothing is scheduled"
      // is half of what makes this tab's writing finished.
      this.#handBackIfQuiet();
    } catch (caught) {
      this.#patch({ createError: describe(caught, "Transcription could not be scheduled.") });
    }
  }

  /**
   * Install a queue over one stored capture and start draining it.
   *
   * `EMPTY_TRANSCRIPT_FOLD` on the resume line is the doubling defect: `base` is
   * the restored draft, which ALREADY holds this capture's settled segments, so
   * a fold starting at zero appends every one of them a second time and the
   * doubled text is what gets POSTed and summarized. `reconcileCaptureDraft` is
   * the shared answer to "which segments does this text already account for",
   * and `beginTranscriptFold` is what carries that answer into the fold.
   *
   * **There is never a queue here to replace.** This used to begin by releasing
   * the lock of whatever capture it was displacing, which was the honest thing
   * to do while a second Record or a Pick up could land on a tab that already
   * held a meeting — that release is what handed a LIVE recording's lock back
   * and left its chunks unclaimed. Both callers are now refused while a capture
   * is in hand, and in hand is exactly "`#queue` is not null", so displacing one
   * cannot happen; a release kept for it would be a line no test could tell from
   * its own absence, and the guard above is where the property is stated.
   */
  #attachQueue(
    store: MeetingCaptureStore,
    session: MeetingCaptureSession,
    options: { readonly mimeType?: string; readonly title?: string; readonly base: string },
  ): MeetingTranscriptionQueue {
    this.#cancelWake();
    // A meeting recorded in Japanese was recorded in Japanese; re-transcribing
    // it as "auto" because the page's dropdown has since been reset is the
    // recovered meeting coming back as a lesser one.
    const sessionLanguage = session.language ?? (this.#state.language === "auto" ? undefined : this.#state.language);
    const queue = createCaptureQueue({
      store,
      session,
      mimeType: options.mimeType ?? DEFAULT_CAPTURE_MIME_TYPE,
      ...(options.title ? { title: options.title } : {}),
      transcribe: this.#ports.createTranscriber(sessionLanguage),
      // One clock for the host and its scheduler. The desktop's supervisor has
      // always passed this; without it here the queue read `Date.now()` while
      // everything around it read the port, so D7's backoff could not be driven
      // by a test at all — and an outage schedule nobody can run is one nobody
      // has checked.
      now: () => this.#ports.now(),
    });
    this.#queue = queue;
    const reconciled = reconcileCaptureDraft(options.base, session);
    this.#fold = beginTranscriptFold(reconciled);
    // Reconciliation heals a stated gap the session has since settled in place,
    // on the way in, so the restored box stops claiming a range could not be
    // transcribed the moment it can be. It never appends: appending is the
    // fold's job, and it resumes at `reconciled.next`.
    if (reconciled.text !== options.base) this.#patch({ transcript: reconciled.text });
    this.#patch({ session, phase: null, retrying: null });
    return queue;
  }

  /**
   * D4 — the ONE place a segment writes into the compose box.
   *
   * The rule is the shared `foldTranscript` and nothing here restates it: text
   * is APPENDED from where the fold left off, a gap it wrote itself is corrected
   * where it sits, and no line the box already holds is ever moved or removed.
   */
  #compose(): void {
    const session = this.#state.session;
    if (!session) return;
    const folded = foldTranscript(this.#state.transcript, session, this.#fold);
    if (!folded.changed) return;
    this.#fold = folded.fold;
    this.#patch({ transcript: folded.text });
    this.#scheduleDraftSave();
  }

  #publishSession(session: MeetingCaptureSession): void {
    this.#patch({ session });
    this.#compose();
  }

  /** D5 — a person can see this gap and is asking for it again, bound or no bound. */
  async retrySegment(index: number): Promise<void> {
    this.#patch({ retrying: index });
    try {
      await this.#runDrain(index);
    } finally {
      this.#patch({ retrying: null });
    }
  }

  // —————————————————————————————————————————————————————— recovery and reap

  /**
   * ADR-035 D2 — a session with audio, no terminal state and nobody writing to
   * it is offered back. D6 rides along: audio whose manifest is gone, or whose
   * meeting is settled, or that was abandoned before its first chunk, can never
   * be offered back, so it is reaped rather than left in the origin's quota.
   *
   * §6's destructive test is decided HERE, and it is decided on the first call
   * rather than eventually. This runs on mount and on an org change and nothing
   * re-runs it, which was fatal while "is somebody writing?" was a stamp with a
   * thirty-second threshold: a tab opened straight after a kill read the dead
   * tab's stamp as fresh, showed an empty device, and never asked again. The
   * lock the dead tab held is already gone, so the same single call now offers
   * the meeting back — no re-check, no waiting, and nothing for a person to
   * press.
   */
  async refreshRecoverable(): Promise<void> {
    const scope = { orgId: this.#ports.activeOrgId() || null };
    const at = this.#instant();
    // The recording happening right now is unfinished by definition; offering it
    // back while the microphone is still open would be nonsense.
    const active = this.#active?.sessionId ?? this.#queue?.session.id;
    let store: MeetingCaptureStore;
    try {
      store = await this.#store(false);
    } catch (caught) {
      // No durable store here, or none we could open. This is NOT "there is
      // nothing to recover": audio already written is still written.
      this.#patch({ recoveryError: `Recordings saved on this device could not be checked — ${describe(caught, "this browser would not open its durable store.")}` });
      return;
    }
    let records: readonly CaptureSessionRecord[];
    try {
      records = await store.list();
    } catch (caught) {
      this.#patch({ recoveryError: `Recordings saved on this device could not be checked — ${describe(caught, "the capture store did not answer.")} Any audio already written is still there.` });
      return;
    }
    // The live set comes from the BROWSER, not from this tab's memory and not
    // from the records: a second tab's recording is invisible to both, and the
    // lock table is the one place every tab of this origin agrees.
    const writers = await this.#ports.locks.writers();
    // D6 — the reap gets its own try. It is housekeeping, and a failed tidy-up
    // must not be reported as an empty device.
    try {
      const reaped = await store.reapOrphans({
        keep: [...(active ? [active] : []), ...writers.ids],
        // Defect C — a capture abandoned before its first chunk. Two records
        // look like that and only one of them is one: the compose draft is a
        // manifest with no audio that is never closed, and a recording waiting
        // on the microphone prompt is holding its lock the whole time.
        //
        // Asked again HERE rather than reusing the set above, and that is the
        // point of the predicate: the reap's own listing is taken after this
        // caller's, so a tab that pressed Record in between is absent from
        // everything computed earlier and present in the browser's answer now.
        //
        // `known` is the fallback's one concession (golden rule 23): a browser
        // with no Web Locks cannot tell a killed prompt from a live one, so it
        // reclaims neither. The cost is metadata left behind on such a browser;
        // the alternative cost is somebody's meeting.
        abandoned: async (record) => {
          if (record.sessionId === MEETING_DRAFT_CAPTURE_ID) return false;
          const now = await this.#ports.locks.writers();
          return now.known && !now.ids.has(record.sessionId);
        },
      });
      // D6 asks for the reap to be logged: audio no session claims is exactly
      // the artifact nobody would otherwise notice.
      if (reaped.length) this.#ports.warn(`[meetings] reaped ${reaped.length} capture(s) no session claims.`);
      // A reap that has now succeeded means the previous failure has stopped
      // being true. Matched on its own text rather than cleared outright,
      // because this slot also carries warnings this says nothing about.
      if (this.#state.warning.startsWith(REAP_WARNING)) this.#patch({ warning: "" });
    } catch (caught) {
      this.#ports.warn("[meetings] the capture reap could not run.", caught);
      this.#patch({ warning: `${REAP_WARNING}${describe(caught, "the capture store refused the delete.")} They are still using storage.` });
    }
    // Open question 5 — the offer is SCOPED, and the scope is the shared
    // `resumableSessions` asked through `resumableCaptures`. The store cannot
    // answer it, because it treats the payload as opaque text.
    //
    // "Nobody is writing to it" is the other half of D2's rule and it is
    // excluded here rather than filtered inside, because the record has nothing
    // to say about live tabs any more: a capture some tab holds the lock for is
    // not offered to anyone, including this one.
    this.#patch({
      recoverable: resumableCaptures(records, {
        scope,
        at,
        exclude: [...(active ? [active] : []), ...writers.ids],
      }),
      writing: [...writers.ids],
      // Golden rule 23 — published so the offer's Discard can SAY what this
      // browser cannot vouch for, in the tooltip and then in the question the
      // function puts. Not so it can be disabled: that row is the only place a
      // Discard is rendered, so disabling it there was audio a person could
      // never remove from their own device. An empty `writing` and an unknown
      // answer look identical from a render, and the difference between them is
      // somebody's live meeting.
      writersKnown: writers.known,
      recoveryError: "",
    });
  }

  /**
   * D2/D3 — pick a crashed recording back up, and carry on transcribing it.
   *
   * The lock is taken FIRST and the pick-up refused if another tab holds it: two
   * queues over one session would interleave their writes, and the second one to
   * persist would erase the first one's segments. A tab that crashed while
   * holding it is not a refusal — the browser released it when the tab died, so
   * the recording is available on the first ask.
   *
   * **And the answer is read the same way here as everywhere else that can cost
   * somebody a meeting**, which it was not. This branched on `hold()` alone and
   * therefore only ever refused `"taken"` — so on a browser with no Web Locks
   * the outcome is `"unavailable"` and the pick-up went through onto a capture
   * another tab had the microphone open on. Reproduced: tab one recording, tab
   * two's Pick up enabled, one click, and Create from tab two posted TAB TWO's
   * transcript and deleted the manifest and every chunk while tab one still said
   * `recording: true` — its next chunk failing with "No meeting capture named …
   * is stored." The rule this round is about ("when we cannot tell whether a
   * meeting is live, we do not act on it as though it were dead") had been
   * applied to the discard and to the reap and not to the button beside them.
   *
   * So `#otherWriter` decides, after the acquisition rather than instead of it:
   * a lock we now hold answers `none` without a query, a lock another tab holds
   * is refused, and an unknown is put to the person, because on that browser
   * they are the only one who can answer it.
   *
   * **And THIS tab is asked about first, which it was not — on every browser,
   * Chrome included.** Nothing here consulted the tab's own state, and the
   * button was disabled by `recording` alone, so Pick up was live across the
   * arming window and across the settle. Three reproduced losses followed from
   * one click. If the microphone opens inside the awaits below, `#attachQueue`
   * used to run a second time and hand `locks.release(previous.session.id)` to
   * the recording that had just started: it then held NO lock, its chunks were
   * written but never claimed as segments, a second tab was OFFERED it, and that
   * tab's Discard asked the ROUTINE question because `writers` legitimately
   * reported nobody holding it — while this tab still said `recording: true`
   * with `warning`, `notice` and `createError` all empty. Deterministically, the
   * adopted meeting's text is folded into the box the live one is writing into,
   * so Create posts both meetings as one and leaves yesterday's on the device to
   * be offered — and posted — again. And from inside the settle, Create posts
   * the merged transcript and releases the PICKED-UP audio, leaving the
   * recording just made unfinalized on a device whose dialog says its audio "is
   * deleted once the meeting is created or you discard it".
   *
   * **And this one MARKS the tab, which it also did not.** The guard above only
   * closes one ordering. A pick-up spends the store open, the lock acquisition
   * and the writer query in awaits, and while it did so it set nothing at all —
   * so a Record pressed in that window saw an idle tab, started, and was then
   * displaced by the `#attachQueue` above running with the NEW recording as its
   * "previous". `#claiming` is what closes the other ordering, and it is the
   * same field `record()` raises, so the two cannot come apart.
   */
  async pickUp(entry: ResumableCapture): Promise<void> {
    // The refusal is in the FUNCTION and not only on the button, for the same
    // reason `discard`'s is: a `disabled` is a statement about a pixel and this
    // adopts a meeting into a tab that already has one.
    if (this.#captureInHand) {
      this.#patch({
        createOpen: true,
        createError: this.#inHandNote(
          "Opening a saved one here would take this tab's hands off it, and both meetings' words would be folded into the one box below.",
        ),
      });
      return;
    }
    this.#patch({ createOpen: true, notice: "", warning: "", createError: "" });
    // Raised before the first await, and lowered in the `finally`: on the way
    // out either `#attachQueue` has left a queue behind — which is this capture
    // in hand by the other half of the predicate — or nothing was adopted and
    // the tab is idle again.
    this.#setClaiming("pick-up");
    try {
      const store = await this.#store(false);
      const { title, mimeType } = parseCapturePayload(entry.record.payload);
      await this.#ports.locks.hold(entry.session.id);
      const writer = await this.#otherWriter(entry.session.id);
      if (writer === "elsewhere") {
        this.#patch({ createError: captureHeldNote(storedStillRecording(entry.record)) });
        return;
      }
      if (writer === "unknown" && !this.#ports.confirm(CAPTURE_PICK_UP_UNKNOWN)) return;
      if (title) this.#patch({ title: this.#state.title || title });
      const queue = this.#attachQueue(store, entry.session, {
        ...(mimeType ? { mimeType } : {}),
        ...(title ? { title } : {}),
        base: this.#state.transcript,
      });
      // Persisted before anything else happens to it, so the recovery stamp this
      // pick-up was judged under is on the device rather than only in this tab.
      await queue.apply((session) => session);
      await this.#runDrain();
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The saved recording could not be read.") });
    } finally {
      this.#setClaiming("");
      await this.refreshRecoverable();
    }
  }

  /**
   * D6 — deletion is a real deletion, it is refused while somebody else is
   * recording into it, and where nobody can say, it is ASKED.
   *
   * The refusal is in the FUNCTION and not only on the button, because the
   * button's `disabled` is a statement about a pixel and this deletes an hour of
   * somebody's meeting.
   *
   * **The three answers, and why the middle one is a question.** A capture this
   * tab is holding is not an uncertainty at all — this tab is the one writing to
   * it — so that is settled first and the browser is only asked about a row this
   * tab never touched. A capture another tab holds is refused outright. An
   * unknown used to be refused too, and that was a delete this browser could
   * never perform on any path: the sentence sent people to "pick it up here
   * first", but a picked-up capture is the ACTIVE one and leaves the offer that
   * renders the only Discard there is, and a reload brings the row back with the
   * same disabled button. D6 says audio is deleted on an explicit discard; a
   * product that prints an instruction its own UI does not permit has not
   * refused a delete, it has lost the audio in the other direction. So the
   * question names what cannot be ruled out and the person answers it.
   *
   * The row this is rendered on belongs to the OFFER, which excludes whatever
   * this tab is holding, so the in-hand branch below is reached from
   * `discardHeld()` in practice and kept here because "is this one mine?" is a
   * question this function must answer before it asks the browser anything.
   */
  async discard(record: CaptureSessionRecord): Promise<void> {
    // A capture that is currently in hand is discarded THROUGH the queue, so the
    // record says it was thrown away rather than merely vanishing — and it is
    // this tab's own, so the browser is not asked about it.
    const inHand = this.#queue?.session.id === record.sessionId;
    // Asked of the browser at the moment of the click, not read off a listing
    // taken when the page rendered: another tab may have pressed Record on this
    // very capture since, and this deletes an hour of somebody's meeting. Before
    // the confirmation rather than after it, because the answer chooses which
    // question gets asked.
    const writer = inHand ? "none" : await this.#otherWriter(record.sessionId);
    if (writer === "elsewhere") {
      this.#patch({ createError: `This recording cannot be deleted. ${captureHeldNote(storedStillRecording(record))}` });
      await this.refreshRecoverable();
      return;
    }
    const question = inHand ? DISCARD_HELD_QUESTION : writer === "unknown" ? CAPTURE_DISCARD_UNKNOWN : DISCARD_QUESTION;
    if (!this.#ports.confirm(question)) return;
    // The player is reading the bytes this is about to delete.
    if (this.#previewRef?.sessionId === record.sessionId) this.#revokePreview();
    try {
      if (inHand) {
        await this.#fileDiscarded();
        return;
      }
      const store = await this.#store(false);
      await store.delete(record.sessionId);
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The recording could not be deleted.") });
    } finally {
      await this.refreshRecoverable();
    }
  }

  /**
   * D6 — throw away the capture this tab is HOLDING, which is the other way a
   * capture is filed and the reason "in hand" is not a wedge.
   *
   * Create is one way out of in-hand and this is the other. Without it a person
   * who recorded something they do not want has no move at all: the offer never
   * lists the capture this tab is holding, so the only Discard in the product is
   * on a row that will never be rendered for it, and Record stays refused for as
   * long as the page is open.
   *
   * Refused while the capture is still LANDING, and the sentence says which
   * window that is: `#release` deletes the audio, and the chunk being written
   * would have nowhere to go — the same reason Create waits, for the same length
   * of time.
   */
  async discardHeld(): Promise<void> {
    if (!this.#queue) return;
    if (this.#captureLanding) {
      this.#patch({
        createError: this.#inHandNote("Discarding it now would delete the audio while a piece of it is still on its way to the store."),
      });
      return;
    }
    if (!this.#ports.confirm(DISCARD_HELD_QUESTION)) return;
    this.#patch({ createError: "" });
    try {
      await this.#fileDiscarded();
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The recording could not be deleted.") });
    } finally {
      await this.refreshRecoverable();
    }
  }

  /**
   * The capture in hand is thrown away, and the compose box goes with it.
   *
   * The box is the second half on purpose. `#release(false)` deletes the audio;
   * the transcript that audio produced is still sitting in front of the person,
   * and leaving it there is the merge arriving one step later — the next
   * recording folds into a box that still holds the meeting just discarded, and
   * Create posts the two as one. So this is the discard's mirror of what
   * `submit` does after a create that landed, and the question the two callers
   * ask says it before anything is deleted.
   */
  async #fileDiscarded(): Promise<void> {
    await this.#release(false);
    this.#patch({ title: "", transcript: "", draftRecovered: false });
    // A discarded meeting starts a new box, so it starts a new fold.
    this.#fold = EMPTY_TRANSCRIPT_FOLD;
    try {
      await clearMeetingDraft(await this.#store(false));
    } catch {
      // The audio is gone, which is what was asked for; a draft that outlives it
      // is overwritten by the next save.
    }
  }

  /**
   * D6 — the audio is released, and the record says why it is gone.
   *
   * The session transition goes through the queue (the single writer) so the
   * manifest is marked closed BEFORE the delete: a kill between the two leaves a
   * closed session that `resumable` will not offer back, which is the right way
   * round.
   *
   * The shared transitions take an optional actor, which they compare against a
   * lease in the session. Nothing writes one here any more, so passing it would
   * be handing a guard an argument it cannot use — "is another tab writing to
   * this?" is asked of the browser by the two callers that can destroy
   * something, before they get this far.
   */
  async #release(accepted: boolean): Promise<void> {
    const queue = this.#queue;
    if (!queue) return;
    this.#queue = null;
    this.#cancelWake();
    const sessionId = queue.session.id;
    this.#revokePreview();
    try {
      await queue.apply((session) => (
        accepted ? finalizeCapture(session, this.#instant()) : discardCaptureSession(session, this.#instant())
      ));
      // Then WAIT for the queue. A segment already in flight persists the whole
      // session when it lands, and a persist that lands after the delete is a
      // manifest written back over a session that no longer exists. Bounded: the
      // transition above is terminal, so no NEW segment is dispatched.
      await queue.drain();
      const store = await this.#store(false);
      await store.delete(sessionId);
    } catch (caught) {
      // NOT the dialog's error slot: every caller of this closes the dialog on
      // the next line, so the one sentence that says the audio is still here
      // could never be read.
      this.#retainAudio(sessionId, caught);
    } finally {
      // This capture has left this tab's hands whichever way the delete went, so
      // the lock goes back even on the failure path — a retained recording that
      // no tab could ever pick up again would be the audio nobody can reach.
      this.#ports.locks.release(sessionId);
      if (this.#handingBack === sessionId) this.#handingBack = null;
      this.#patch({ session: null, phase: null, retrying: null });
    }
  }

  /**
   * D6 — the audio survived a delete that did not, and the user is told where it
   * is rather than left with a meeting whose recording quietly persists.
   */
  #retainAudio(sessionId: string, caught: unknown): void {
    const detail = describe(caught, "the capture store refused the delete.");
    this.#patch({
      retained: [
        ...this.#state.retained.filter((row) => row.sessionId !== sessionId),
        { sessionId, message: `A recording's audio is still saved on this device — ${detail}` },
      ],
    });
  }

  /** The retry for a delete that failed — D6's "deletion is a real deletion", asked again. */
  async releaseRetained(sessionId: string): Promise<void> {
    try {
      const store = await this.#store(false);
      await store.delete(sessionId);
      this.#patch({ retained: this.#state.retained.filter((row) => row.sessionId !== sessionId) });
    } catch (caught) {
      this.#retainAudio(sessionId, caught);
    }
  }

  /**
   * §6 — hear the recording that came back.
   *
   * Reassembling the whole capture is the one place that is the right thing to
   * do: the transcription path deliberately never does it (D3), but a person
   * listening needs the meeting, not a segment.
   *
   * **Which LIFE of the page an answer belongs to is asked before the URL is
   * minted.** This reads a whole recording back across two awaits. A ▶ Play that
   * resolves after `dispose()` used to mint an object URL over an hour of audio
   * that nothing would ever revoke — `#revokePreview()` ran during the teardown,
   * before the URL existed, and the page that could revoke it has gone. That is
   * §1's defect in miniature: bytes pinned in the tab's heap by a closure
   * nothing can reach. `#attempt` already counts the lives, for the same reason
   * and with the same shape as the desktop's `ComposeFormLife`: what is
   * cancelled is one ATTEMPT, so a StrictMode remount simply plays in its own.
   */
  async previewCapture(record: CaptureSessionRecord): Promise<void> {
    if (this.#previewRef?.sessionId === record.sessionId) {
      this.#revokePreview();
      return;
    }
    this.#patch({ busy: "preview" });
    const life = this.#attempt;
    try {
      const store = await this.#store(false);
      const { mimeType } = parseCapturePayload(record.payload);
      const audio = await store.readAudio(record.sessionId, mimeType || DEFAULT_CAPTURE_MIME_TYPE);
      // Immediately before the mint, and after the last await: any earlier and
      // the read could still outlive the check, any later and the URL exists.
      if (this.#attempt !== life) return;
      this.#revokePreview();
      const url = this.#ports.createObjectUrl(audio.blob);
      this.#previewRef = { sessionId: record.sessionId, url };
      this.#patch({ preview: { sessionId: record.sessionId, url, missing: audio.missing.length } });
    } catch (caught) {
      this.#patch({ createError: describe(caught, "This recording could not be read back from this device.") });
    } finally {
      this.#patch({ busy: "" });
    }
  }

  /** Put the object URL back, and forget the recording it was playing. */
  #revokePreview(): void {
    if (!this.#previewRef) return;
    this.#ports.revokeObjectUrl(this.#previewRef.url);
    this.#previewRef = null;
    this.#patch({ preview: null });
  }

  // ————————————————————————————————————————————————————————————— the POST

  /**
   * D5/D6/open question 5 — create the meeting from what is in the box, then
   * release the audio.
   *
   * Three facts have to be true at once here and each of them has been wrong on
   * this host at least once: what is posted is the SETTLED text (a provisional
   * segment contributes nothing, so the sentences either side of it read as
   * contiguous speech), the audio is released only AFTER the meeting exists on
   * the server, and the workspace is the one frozen at Record rather than the
   * one the switcher happens to be showing.
   */
  async submit(): Promise<void> {
    const title = this.#state.title.trim();
    if (!title || !this.#state.transcript.trim()) {
      this.#patch({ createError: "A title and a transcript are required." });
      return;
    }
    // Guarded here as well as on the button, because this is the DESTRUCTIVE
    // path: it finalizes the capture and deletes its audio, and `recording` is
    // false for TWO stretches either side of the meeting — the arming window in
    // front of two permission prompts, and the settle in which the last chunk is
    // still being written.
    //
    // `#captureLanding`, deliberately, and NOT the in-hand predicate the two
    // controls above are refused by. This is the control that ENDS in-hand: a
    // capture is this tab's until the meeting exists on the server, so keying
    // Create on that would refuse the one press that can put it down and leave a
    // recording nothing could ever file.
    const landing = this.#captureLanding;
    if (landing || this.#state.busy || this.#ports.otherBusy()) {
      this.#patch({
        createError: this.#state.recording
          ? "Stop the recording before creating the meeting — creating it releases the captured audio, and the chunk being written right now would have nowhere to land."
          : landing
            ? "The end of this recording is still being written to this device — creating the meeting now would release its audio while the last piece is still in flight. This takes a moment."
            : "Something else is still running here — try again in a moment.",
      });
      return;
    }
    const queue = this.#queue;
    // …and the one the other three cannot see: another tab may have picked this
    // recording up since this one stopped, and Create FINALIZES the capture and
    // DELETES its audio — so from here it would destroy a meeting somebody else
    // is recording into right now.
    //
    // Asked of the browser, not of `queue.session`. The queue holds this tab's
    // own in-memory copy, which was last read before the other tab existed and
    // will therefore always say the coast is clear — the exact mistake the offer
    // and the reap were rewritten to stop making, left in the one path that
    // deletes audio. `known: false` allows it through deliberately: a browser
    // that cannot see other tabs must not be a browser where Create is wedged
    // for ever, and its user has been told so since the page loaded.
    if (queue && await this.#otherWriter(queue.session.id) === "elsewhere") {
      this.#patch({ createError: `This meeting cannot be created from this tab. ${captureHeldNote(queue.session.status === "recording")}` });
      return;
    }
    this.#patch({ busy: "create", createError: "" });
    try {
      // D5 — the meeting is about to be created from this text and the audio
      // deleted a moment later, so a segment the queue has not resolved will
      // never reach it. It goes in as a stated gap with its time range instead.
      // `submitted.text` is what gets posted, directly: there is deliberately no
      // local in between for a mutation to leave stale.
      const submitted = settleTranscriptForSubmit(this.#state.transcript, queue?.session ?? null, this.#fold);
      this.#fold = submitted.fold;
      if (submitted.changed) this.#patch({ transcript: submitted.text });
      // Open question 5 — the recording's org was frozen at Record, and this is
      // the one call that could still move it. ADR-019's switcher can change the
      // active org mid-meeting; sending the CURRENT one would land an hour of
      // somebody's audio in whichever workspace happened to be selected when
      // they pressed Create. A pasted transcript has no capture and no frozen
      // scope, so it uses the active org as before.
      const captureOrgId = queue?.session.scope.orgId;
      const meetingOrgId = captureOrgId === undefined ? this.#ports.activeOrgId() : captureOrgId;
      const out = await this.#ports.createMeeting({
        title,
        transcript: submitted.text,
        template: this.#state.template,
        orgId: meetingOrgId,
      });
      // D6 — "audio is deleted when the meeting is summarized and the user has
      // accepted it". This is that moment, and only this moment: it runs after
      // the meeting exists on the server, so a failed create leaves the
      // recording on the device to be offered back rather than throwing it away.
      await this.#release(true);
      this.#patch({ createOpen: false, title: "", transcript: "", draftRecovered: false });
      this.#fold = EMPTY_TRANSCRIPT_FOLD;
      try {
        await clearMeetingDraft(await this.#store(false));
      } catch {
        // The meeting is created; a draft that outlives it is tidied on the next save.
      }
      await this.refreshRecoverable();
      this.#ports.onCreated(out.id);
    } catch (caught) {
      this.#patch({ createError: describe(caught, "Could not create the meeting.") });
    } finally {
      this.#patch({ busy: "" });
    }
  }

  /**
   * ADR-035 D8 — the IMPORT path, and only that one.
   *
   * A user handing us a file really can hand us an hour of audio in one piece,
   * so the endpoint's body limit is a real ceiling here and refusing early is
   * kinder than a 413 after a long upload. Recorded captures no longer come
   * through here at all.
   */
  async importAudio(blob: Blob): Promise<boolean> {
    this.#patch({ busy: "transcribe", createError: "" });
    try {
      if (!blob.size) throw new Error("The selected audio file is empty.");
      if (blob.size > 40 * 1024 * 1024) throw new Error("Audio must be 40 MB or smaller.");
      const text = (await this.#ports.transcribeFile(blob, this.#state.language)).trim();
      if (text) {
        const current = this.#state.transcript;
        this.#patch({ transcript: current ? `${current}\n${text}` : text });
        this.#scheduleDraftSave();
        return true;
      }
      this.#patch({ createError: "No speech was detected in the recording." });
      return false;
    } catch (caught) {
      this.#patch({ createError: describe(caught, "Transcription failed.") });
      return false;
    } finally {
      this.#patch({ busy: "" });
    }
  }

  // ————————————————————————————————————————————————————————————— teardown

  /**
   * The page is going away. The recording must not.
   *
   * D1b — "a closing tab gets very little time, so nothing important may be
   * deferred to the moment the tab dies" — and none of this is deferred work:
   * the audio and the session are already written. What is here is the three
   * things that outlive a React tree and should not: an open MICROPHONE with a
   * recorder writing chunks through a closure nothing can reach any more, an
   * object URL over an hour of audio, and the locks.
   *
   * The locks are the one that needs saying. A client-side navigation leaves the
   * tab alive, so nothing would release them and the meeting would stay out of
   * this browser's offer until the tab was closed — hence `releaseAll`. A tab
   * that is KILLED never reaches this line and does not need to: the browser
   * drops what it held, so nothing here is a promise §6 depends on.
   *
   * What it IS load-bearing for is a Record that has not finished arming.
   * `releaseAll()` here and a `hold()` still in flight over there are a race
   * this teardown loses on its own — it can hand back a lock the recording is
   * about to start using, or run entirely before the lock is taken and leave one
   * nothing will ever release. The two lines below are for that: `record()`
   * abandons an arming whose attempt is no longer the current one, and refuses
   * to start a new one at all until a mount clears the flag.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#attempt += 1;
    this.#cancelWake();
    this.#flushDraftSave();
    this.#revokePreview();
    const recorder = this.#recorder;
    this.#recorder = null;
    if (recorder) {
      try {
        recorder.stop();
      } catch {
        // A recorder that will not stop still has to release the microphone.
      }
      this.#microphone?.release();
      // `onstop` settles the capture, which is where the stop transition and the
      // lock release happen. Awaited so a caller — a test, or a host that has a
      // moment — can know the recording landed.
      await this.#finishing;
    } else {
      this.#microphone?.release();
    }
    this.#microphone = null;
    // Last, and unconditional: a picked-up capture still draining, a recording
    // whose settle threw, a lock taken for a session that never got a
    // microphone. All of them belong to a tab that is about to stop existing as
    // far as this page is concerned.
    this.#ports.locks.releaseAll();
    this.#patch({ recording: false, paused: false });
  }

  // ————————————————————————————————————————————————————————————— plumbing

  /**
   * Is a DIFFERENT tab writing to this capture at this instant — the question
   * both destructive paths ask, and the only place that decides it.
   *
   * Three answers rather than two, and the third is the point. A lock this tab
   * holds is not somebody else's (`none` — a picked-up capture is created from
   * the tab that picked it up); a lock another tab holds is `elsewhere`; and a
   * browser that cannot see other tabs at all is `unknown`, which is NOT the
   * same fact as `none` however similar the empty set looks.
   *
   * The three callers read `unknown` differently, on purpose, and none of them
   * refuses it. Create TAKES it silently, because it can only ever finalize a
   * capture this tab has been writing itself and a confirmation on every meeting
   * made on such a browser would teach people to click through the two that mean
   * something. Discard and Pick up ASK — each with its own sentence naming its
   * own consequence — because they act on a row this tab never touched, and one
   * of them deletes an hour of somebody's meeting while the other puts a second
   * queue over it. Refusing was tried and was worse: the only Discard there is
   * lives on the offer's row, so a browser that refused had no path to D6's
   * "audio is deleted on an explicit discard" at all.
   */
  async #otherWriter(sessionId: string): Promise<"none" | "elsewhere" | "unknown"> {
    if (this.#ports.locks.holds(sessionId)) return "none";
    const writers = await this.#ports.locks.writers();
    if (writers.ids.has(sessionId)) return "elsewhere";
    return writers.known ? "none" : "unknown";
  }

  /**
   * One store per surface, opened lazily. `requestPersistence` is false
   * everywhere except Record: opening it to look for a recovered meeting must
   * not put a storage-permission prompt in front of someone browsing a library.
   */
  async #store(requestPersistence: boolean): Promise<MeetingCaptureStore> {
    const cached = this.#opened;
    let opened = cached && (!requestPersistence || cached.persisted) ? cached : undefined;
    if (!opened) {
      // Deduped, because two callers ask for the store on the same mount — the
      // draft and the recovery offer. Two stores over one origin would be two
      // write queues, and the per-session ordering this design rests on is per
      // instance.
      const pending = this.#opening ?? this.#ports.openStore(requestPersistence);
      this.#opening = pending;
      try {
        opened = await pending;
      } finally {
        if (this.#opening === pending) this.#opening = null;
      }
    }
    this.#opened = opened;
    // Read the budget on EVERY Record, including the one that reused an
    // already-open store: tying the notice to the open meant the second
    // recording of a session heard nothing until the first chunk landed.
    if (requestPersistence) {
      const notice = [captureFallbackNotice(opened), (await opened.store.budget()).message].filter(Boolean).join(" ");
      this.#patch({ notice });
    }
    return opened.store;
  }

  /**
   * Whether a refused chunk write means the store is full — the one write
   * failure that is terminal and must stop the recorder. Asked two ways because
   * browsers disagree about how they say it.
   */
  async #captureIsFull(capture: ActiveCapture, caught: unknown): Promise<boolean> {
    if (isStorageQuotaError(caught)) return true;
    try {
      const budget = await capture.store.budget({
        byteLength: capture.bytes,
        recordedMs: this.#ports.now() - capture.startedMs,
      });
      return budget.level === "exhausted";
    } catch {
      // A budget we cannot read is not evidence of a full store, and stopping a
      // recording on a guess is its own kind of loss.
      return false;
    }
  }

  /**
   * D6 — persist the compose box exactly as it stands.
   *
   * The WHOLE box, never `reconcileCaptureDraft(...).retained`: a stripped
   * complement is reconciled a second time on the way back in, and the four
   * corruptions that follow are all silent. It is also what makes the fold's
   * resume point reconstructible, because a box holding this capture's segments
   * verbatim is one `reconcileCaptureDraft` can say WHICH and WHERE about.
   */
  #scheduleDraftSave(): void {
    if (!this.#state.draftReady || this.#disposed) return;
    if (this.#draftSave !== null) this.#ports.clearTimer(this.#draftSave);
    this.#draftSave = this.#ports.setTimer(() => {
      this.#draftSave = null;
      void this.#writeDraft();
    }, DRAFT_SAVE_DELAY_MS);
  }

  #flushDraftSave(): void {
    if (this.#draftSave === null) return;
    this.#ports.clearTimer(this.#draftSave);
    this.#draftSave = null;
    void this.#writeDraft();
  }

  async #writeDraft(): Promise<void> {
    try {
      const store = await this.#store(false);
      await writeMeetingDraft(store, {
        title: this.#state.title,
        transcript: this.#state.transcript,
        language: this.#state.language,
        template: this.#state.template,
      });
    } catch {
      // A draft that could not be saved is not worth an alert of its own.
    }
  }

  #cancelWake(): void {
    if (this.#wake === null) return;
    this.#ports.clearTimer(this.#wake);
    this.#wake = null;
  }

  #instant(): string {
    return new Date(this.#ports.now()).toISOString();
  }

  #patch(next: Partial<CaptureSurfaceState>): void {
    this.#state = { ...this.#state, ...next };
    // Derived after the merge, here and nowhere else, so the copies the buttons
    // read cannot disagree with the predicates the functions read. Both are made
    // of private fields no patch can carry, and a second hand-kept copy of
    // either answer is exactly how the four deleted guards came apart.
    this.#state = { ...this.#state, capturing: this.#captureInHand, landing: this.#captureLanding };
    for (const listener of this.#listeners) listener();
  }
}
