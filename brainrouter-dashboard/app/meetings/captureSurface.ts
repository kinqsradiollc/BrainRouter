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
 * **Liveness is in the record, not in this object.** Four rounds of guards —
 * `captureRef.current`, `queueRef.current` here, `hold.sessionId` and
 * `captureInFlight(hold)` on the desktop — were the same mistake four times:
 * state in ONE mount describing a store scoped to the whole ORIGIN. A second tab
 * has an empty guard, so every "is something recording?" question answers false
 * and the live meeting is offered back with an enabled Discard beside it. The
 * shared `captureLease` moves that fact into the session record every holder
 * already reads; this module acquires, heartbeats and releases it, and asks it
 * back at the four places that can destroy a recording — the offer, the discard,
 * the reap and the create guard.
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
  acquireCaptureLease,
  appendSegment,
  beginTranscriptFold,
  capturesBeingWritten,
  createCaptureSession,
  describeCaptureWriter,
  discardCapture as discardCaptureSession,
  drainWakeDelayMs,
  EMPTY_TRANSCRIPT_FOLD,
  finalizeCapture,
  foldTranscript,
  heartbeatCaptureLease,
  isCaptureLeaseFresh,
  MEETING_CAPTURE_HEARTBEAT_MS,
  reconcileCaptureDraft,
  releaseCaptureLease,
  settleTranscriptForSubmit,
  stopCapture,
  unsettledSegments,
  type MeetingCaptureLease,
  type MeetingCaptureLeaseClaim,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingDrainPhase,
  type MeetingTranscriptionQueue,
  type TranscriptFold,
} from "@kinqs/brainrouter-core/meetings";

import {
  isCapturePayloadBeingWritten,
  parseCapturePayload,
  restoreCaptureSession,
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

/** What a surface calls this tab when it is holding a recording someone else wants. */
export const CAPTURE_HOLDER_LABEL = "Another tab";

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
  /** This TAB's writer id (`captureHolder.ts`), threaded into every lease call. */
  readonly holderId: string;
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
 * What one heartbeat learned.
 *
 * `unknown` is the answer that has to exist: a record that cannot be read after
 * this tab's own term has lapsed leaves it unable to say whether it is still the
 * writer or a zombie whose recording was taken over, and the two call for
 * opposite things.
 */
export type CaptureBeat = "held" | "lost" | "unknown" | "unheld";

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
  /** A READING: which store, how much room. Rewritten by every chunk. */
  readonly notice: string;
  /** An EVENT that is still true: a failed persist, a full store, a lost lease. */
  readonly warning: string;
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
  notice: "",
  warning: "",
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

/** An error's own words when it has any, and a plain sentence when it does not. */
export function describe(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message.trim() : "";
  return message || fallback;
}

export class MeetingCaptureSurface {
  readonly #ports: CaptureSurfacePorts;

  #state: CaptureSurfaceState = EMPTY_STATE;

  readonly #listeners = new Set<() => void>();

  #opened: OpenedCaptureStore | null = null;

  #opening: Promise<OpenedCaptureStore> | null = null;

  /** The recording in hand — the guard `submit` reads, and the one `dispose` stops. */
  #active: ActiveCapture | null = null;

  #recorder: CaptureRecorder | null = null;

  #microphone: CaptureMicrophone | null = null;

  /**
   * True from the instant Record is pressed until the recorder is running or has
   * failed to start — the window `recording` is false in while a live queue over
   * a real session already exists.
   */
  #arming = false;

  /** One per meeting, and the SINGLE WRITER of its session while it exists. */
  #queue: MeetingTranscriptionQueue | null = null;

  /** What this tab believes it holds, or `null` when it holds nothing. */
  #claim: MeetingCaptureLeaseClaim | null = null;

  #wake: number | null = null;

  #beat: number | null = null;

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

  /**
   * The chunks being written RIGHT NOW.
   *
   * `MediaRecorder` delivers its final `ondataavailable` and fires `onstop`
   * immediately after it, from a handler that cannot await anything — so at the
   * instant Stop settles the capture, the last piece of the meeting is somewhere
   * between the media stack and the store. `store.settled()` waits for writes it
   * has already been GIVEN, which is not the same thing: this set is the step
   * before that, and without it a chunk still ahead of `appendChunk` is settled
   * around rather than waited for. It used to work by accident, because
   * `appendChunk` was the first statement and therefore joined the store's queue
   * synchronously; the heartbeat that now precedes it broke that accident, and a
   * meeting was settled without its ending. Tracking the work says what was
   * meant instead of depending on the order of two awaits.
   */
  readonly #chunkWork = new Set<Promise<void>>();

  #disposed = false;

  constructor(ports: CaptureSurfacePorts) {
    this.#ports = ports;
  }

  // ————————————————————————————————————————————————————————— the React seam

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): CaptureSurfaceState => this.#state;

  /** This tab's writer id, so a surface can ask "is that lease mine?" while rendering. */
  get holderId(): string {
    return this.#ports.holderId;
  }

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
    if (draft) {
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
   * D2 — pressing Record creates the session, and D6 — the writer is named in
   * that session BEFORE the manifest is written, so the very first thing on this
   * device says who is recording. A tab killed during the microphone prompt is
   * then distinguishable from one still waiting for it, which is the whole of
   * defect C.
   */
  async record(): Promise<void> {
    this.#patch({ createError: "", warning: "" });
    // Raised before the first await and lowered only once the recorder is
    // running (or has failed to start). `recording` cannot cover this stretch:
    // it is set at the very end, and by then the queue has existed — and been
    // the single writer of a real session — for two awaits.
    this.#arming = true;
    const title = this.#state.title.trim();
    const startedMs = this.#ports.now();
    const startedAt = new Date(startedMs).toISOString();
    let store: MeetingCaptureStore;
    let sessionId: string;
    let session: MeetingCaptureSession;
    try {
      store = await this.#store(true);
      sessionId = newCaptureSessionId();
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
      const lease = acquireCaptureLease(session, { holderId: this.#ports.holderId, holder: CAPTURE_HOLDER_LABEL }, startedAt);
      if (!lease.ok) throw new Error(lease.detail);
      session = lease.session;
      this.#claim = { holderId: lease.lease.holderId, epoch: lease.lease.epoch };
      await store.begin({ sessionId, startedAt, payload: serializeCapturePayload({ ...(title ? { title } : {}), session }) });
      // Started before `getUserMedia`, not after: the prompt can sit on screen
      // for a minute, and a lease nobody is renewing across it is a live
      // recording that every other tab reads as abandoned.
      this.#startHeartbeat();
    } catch (caught) {
      this.#arming = false;
      this.#claim = null;
      this.#stopHeartbeat();
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
      this.#active = capture;
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
      const recorder = microphone.recorder;
      const opened = microphone;
      recorder.ondataavailable = (event) => {
        if (event.data.size) this.#trackChunk(this.#persistChunk(capture, event.data));
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
      this.#patch({ recording: true, paused: false });
      this.#arming = false;
    } catch {
      this.#arming = false;
      // A recorder that would not start leaves the stream live and `onstop`
      // never runs, so without this the microphone stays open with nothing
      // recording it.
      microphone?.release();
      this.#stopHeartbeat();
      this.#claim = null;
      this.#recorder = null;
      this.#microphone = null;
      // Only tear down the queue and the guard if they are THIS recording's: a
      // previous capture may still be legitimately draining, and dropping the
      // guard for one that has only just begun is the same defect with the
      // opposite sign. Leaking it wedges Create PERMANENTLY — every later submit
      // refuses with "stop the recording first" while `recording` is false and
      // the button says "Record".
      if (this.#queue?.session.id === sessionId) {
        this.#queue = null;
        this.#patch({ session: null });
      }
      if (this.#active?.sessionId === sessionId) this.#active = null;
      void store.delete(sessionId).catch(() => {});
      this.#patch({ createError: "Microphone access was denied or is unavailable." });
    }
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
   * The heartbeat rides here as well as on the timer, and that is not belt and
   * braces: in a BACKGROUND tab timers are clamped, and a recording tab the user
   * has switched away from is exactly the second-holder case the lease exists
   * for. `ondataavailable` comes from the media stack rather than from a timer,
   * so a throttled tab still stamps its record on the chunk cadence.
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
    const holding = this.#queue;
    const beat = await this.#beatLease();
    // The heartbeat is what discovers that another tab took this recording over,
    // and a tab that has lost it — or that cannot tell whether it still holds it
    // — must not append its microphone's audio to a meeting somebody else may
    // now be writing. `unknown` is only ever returned once this tab's own term
    // has lapsed AND the record cannot be read, so a healthy recording never
    // takes this path.
    if (this.#queue !== holding || beat === "unknown") return;
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
   * **The guard is released as soon as the recording has landed, and not one
   * step later.** It used to be held across `await this.#runDrain()`, and a
   * drain runs until nothing is ready — through every retry of every failed
   * segment, and under D7 through an outage of any length. So long after the
   * final chunk was safely on the device, Create still refused with "The end of
   * this recording is still being written to this device", which by then was
   * simply untrue: the sentence names the last chunk, and the last chunk landed
   * at `settled()`. What the drain is doing afterwards is transcription, and a
   * segment that has not transcribed is what `unresolvedSegments` already says
   * out loud and what `settleTranscriptForSubmit` states as a gap.
   */
  async #finishCapture(capture: ActiveCapture): Promise<void> {
    this.#patch({ settling: true });
    try {
      // The final chunk arrives at `ondataavailable` and `onstop` fires straight
      // after it, so at this instant the last piece of the meeting is still on
      // its way to the store. Both halves are waited for, in this order: the
      // chunk handlers that have not reached `appendChunk` yet, and then the
      // store's own write queue. Either one alone settles the meeting without
      // its ending.
      await this.#settleChunks();
      await capture.store.settled(capture.sessionId);
      const queue = this.#queue;
      if (!queue || queue.session.id !== capture.sessionId) return;
      const claim = this.#claim;
      // Ordered after the final chunk's own `apply` by the queue's write chain,
      // so `stopCapture` cannot land before the segment it belongs with. The
      // lease is handed back in the SAME transition, so a cleanly stopped
      // meeting is offerable at once rather than after the staleness window.
      await queue.apply((session) => {
        const stopped = session.status === "recording" ? stopCapture(session, this.#instant()) : session;
        if (!claim) return stopped;
        const released = releaseCaptureLease(stopped, claim, this.#instant());
        return released.ok ? released.session : stopped;
      });
      this.#claim = null;
      this.#stopHeartbeat();
      this.#publishSession(queue.session);
      if (!queue.session.segments.length) {
        this.#patch({ createError: "No audio was captured — check that the right microphone is selected." });
        await this.#release(false);
        return;
      }
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The recording could not be settled.") });
    } finally {
      // Identity-checked rather than cleared outright: a new recording can be
      // started while this one is still settling. In the `finally` so that a
      // settle which THREW still releases it — otherwise the failure that
      // stopped the meeting being finished would also wedge Create for good.
      if (this.#active === capture) this.#active = null;
      this.#patch({ settling: false });
    }
    await this.refreshRecoverable();
    // Transcription continues out here, with nothing held: the audio is on the
    // device and the guard's sentence has stopped being true. Awaited rather
    // than fired and forgotten so that `dispose()` — which waits for this whole
    // settle — gives a meeting one more transcription pass before the page goes.
    // The chunk that landed a moment ago has already scheduled a drain of its
    // own, so this is a second chance rather than the only one.
    await this.#runDrain();
  }

  // ——————————————————————————————————————————————————————————— the lease

  /**
   * Still here.
   *
   * Two answers matter and they are not the same answer. A renewal that is
   * REFUSED because another holder has the recording (`held_by_another`,
   * `stale_epoch`) means this tab lost it, and continuing to record would write
   * audio into a session somebody else is finalizing. A renewal refused because
   * the TERM RAN OUT means nothing of the sort: the shared rule deliberately
   * never revives an expired lease — that is 048's leaked unfenced heartbeat —
   * and its own remedy is to acquire again, which mints a new epoch and fences
   * whatever was carrying the old one.
   *
   * That second case is not exotic here, it is the common one: a BACKGROUND tab
   * has its timers clamped, so the only heartbeat it gets is the chunk's, and a
   * throttled cadence longer than the staleness window would otherwise stop a
   * perfectly live recording dead. Re-acquiring keeps it recording unless
   * somebody actually took it, which is exactly the distinction the lease is for.
   */
  async #beatLease(): Promise<CaptureBeat> {
    const queue = this.#queue;
    const claim = this.#claim;
    if (!queue || !claim) return "unheld";
    const at = this.#instant();
    // **The STORED lease is the authority, never the queue's copy of it.** The
    // queue holds this tab's own session in memory, and a tab that was frozen
    // for a minute holds a session that knows nothing about the tab that took
    // the recording over meanwhile — so renewing against it would hand the
    // recording back to the writer the fence was raised against, and the next
    // persist would write this tab's segments over the other tab's. This read is
    // the whole difference between a lease and a fourth in-memory guard.
    let stored: MeetingCaptureLease | undefined;
    try {
      const record = await (await this.#store(false)).read(queue.session.id);
      stored = record ? parseCapturePayload(record.payload).writer : undefined;
    } catch {
      // A record we could not read is not evidence of anything — least of all
      // that this tab still holds the recording. Renewing on a reading we do not
      // have could hand the recording back to the writer a fence was raised
      // against, so the beat says what it actually knows instead.
      //
      // The answer is not the same in both directions, and the difference is the
      // whole of it. INSIDE our own term nobody can legitimately have taken this
      // recording, so an unreadable record changes nothing and the meeting keeps
      // being written — the ADR's own rule, which is that a store having a bad
      // moment must not cost somebody their audio. Once the term has lapsed we
      // cannot tell a healthy recording from a zombie one, and a zombie's next
      // persist would write this tab's session over the tab that took it: so
      // that is the case, and only that case, where the write waits.
      return isCaptureLeaseFresh(queue.session.writer, at) ? "held" : "unknown";
    }
    // The ONE place that decides this tab has lost the recording. Everything
    // below runs only when the record still says this claim holds it, or says
    // nothing fresh at all.
    if (stored && (stored.holderId !== claim.holderId || stored.epoch !== claim.epoch) && isCaptureLeaseFresh(stored, at)) {
      this.#loseRecording(
        describeCaptureWriter({ ...queue.session, writer: stored }, this.#ports.holderId, at)
          ?? "Another tab is recording this meeting right now.",
      );
      return "lost";
    }
    // An array rather than a `let`, because a variable assigned only inside a
    // closure keeps its initializer's narrowing and the renewal would read as
    // unreachable.
    const renewed: MeetingCaptureLeaseClaim[] = [];
    try {
      await queue.apply((session) => {
        // Judged against the stored lease and written back through the single
        // writer, so the epoch advances past whatever the record last held.
        const current = stored ? { ...session, writer: stored } : session;
        const outcome = heartbeatCaptureLease(current, claim, at);
        if (outcome.ok) return outcome.session;
        if (outcome.reason === "capture_closed") return session;
        // The term ran out — which the shared rule refuses to revive, and whose
        // own remedy is to acquire again. That is the common case here, not an
        // exotic one: a background tab's timers are clamped, so its only
        // heartbeat is the chunk's, and a cadence longer than the window would
        // otherwise stop a perfectly live recording dead.
        const retaken = acquireCaptureLease(current, { holderId: this.#ports.holderId, holder: CAPTURE_HOLDER_LABEL }, at);
        if (!retaken.ok) return session;
        renewed.push({ holderId: retaken.lease.holderId, epoch: retaken.lease.epoch });
        return retaken.session;
      });
    } catch (caught) {
      this.#patch({ warning: `This recording's progress could not be saved on this device — ${describe(caught, "the capture store refused the write.")}` });
      return "held";
    }
    if (renewed.length) this.#claim = renewed[0];
    return "held";
  }

  /**
   * Another holder has this recording. Stop, say so, and touch NOTHING else —
   * the session belongs to whoever took it, and finalizing or deleting it from
   * here is exactly the destruction the lease exists to prevent.
   */
  #loseRecording(detail: string): void {
    this.#claim = null;
    this.#stopHeartbeat();
    const recorder = this.#recorder;
    this.#recorder = null;
    this.#queue = null;
    try {
      recorder?.stop();
    } catch {
      // A recorder that will not stop still has to release the microphone below.
    }
    this.#microphone?.release();
    this.#microphone = null;
    this.#active = null;
    this.#patch({
      recording: false,
      paused: false,
      warning: `This recording is no longer being written by this tab — ${detail} Recording here has stopped so the two do not write over each other.`,
    });
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    if (this.#disposed) return;
    this.#beat = this.#ports.setTimer(() => {
      this.#beat = null;
      void this.#beatLease().finally(() => {
        if (this.#claim) this.#startHeartbeat();
      });
    }, MEETING_CAPTURE_HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#beat === null) return;
    this.#ports.clearTimer(this.#beat);
    this.#beat = null;
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
    // D6 — the reap gets its own try. It is housekeeping, and a failed tidy-up
    // must not be reported as an empty device.
    try {
      // The live set is read off the RECORDS, not off this tab's memory: the
      // whole point of the lease is that a second tab's recording is invisible
      // to everything except the record it is stamping.
      const live = capturesBeingWritten(
        records.map((record) => restoreCaptureSession({ record, scope, at })),
        at,
      ).map((session) => session.id);
      const reaped = await store.reapOrphans({
        keep: [...(active ? [active] : []), ...live],
        // Defect C — a capture abandoned before its first chunk. Two records
        // look like that and only one of them is one: the compose draft is a
        // manifest with no audio that is never closed, and a recording waiting
        // on the microphone prompt is stamping its lease the whole time.
        abandoned: (record) => (
          record.sessionId !== MEETING_DRAFT_CAPTURE_ID
          && !isCapturePayloadBeingWritten(record.payload, at)
        ),
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
    this.#patch({
      recoverable: resumableCaptures(records, {
        scope,
        at,
        ...(active ? { exclude: [active] } : {}),
      }),
      recoveryError: "",
    });
  }

  /**
   * D2/D3 — pick a crashed recording back up, and carry on transcribing it.
   *
   * The lease is taken FIRST and the pick-up refused if another tab still holds
   * it: two queues over one session would interleave their writes, and the
   * second one to persist would erase the first one's segments.
   */
  async pickUp(entry: ResumableCapture): Promise<void> {
    this.#patch({ createOpen: true, notice: "", warning: "", createError: "" });
    try {
      const store = await this.#store(false);
      const { title, mimeType } = parseCapturePayload(entry.record.payload);
      const taken = acquireCaptureLease(
        entry.session,
        { holderId: this.#ports.holderId, holder: CAPTURE_HOLDER_LABEL },
        this.#instant(),
      );
      if (!taken.ok) {
        this.#patch({ createError: taken.detail });
        return;
      }
      this.#claim = { holderId: taken.lease.holderId, epoch: taken.lease.epoch };
      if (title) this.#patch({ title: this.#state.title || title });
      const queue = this.#attachQueue(store, taken.session, {
        ...(mimeType ? { mimeType } : {}),
        ...(title ? { title } : {}),
        base: this.#state.transcript,
      });
      // Persisted before anything else happens to it, so a second tab can see
      // this one holding the recording rather than inferring it later.
      await queue.apply((session) => session);
      this.#startHeartbeat();
      await this.#runDrain();
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The saved recording could not be read.") });
    } finally {
      await this.refreshRecoverable();
    }
  }

  /**
   * D6 — deletion is a real deletion, and it is refused while somebody is
   * recording into it.
   *
   * The refusal is in the FUNCTION and not only on the button, because the
   * button's `disabled` is a statement about a pixel and this deletes an hour of
   * somebody's meeting.
   */
  async discard(record: CaptureSessionRecord): Promise<void> {
    if (!this.#ports.confirm("Discard this unfinished recording? Its audio is deleted from this device.")) return;
    // The player is reading the bytes this is about to delete.
    if (this.#previewRef?.sessionId === record.sessionId) this.#revokePreview();
    try {
      // A capture that is currently in hand is discarded THROUGH the queue, so
      // the record says it was thrown away rather than merely vanishing.
      if (this.#queue?.session.id === record.sessionId) {
        await this.#release(false);
        return;
      }
      const store = await this.#store(false);
      const at = this.#instant();
      const writer = describeCaptureWriter(
        restoreCaptureSession({ record, scope: { orgId: this.#ports.activeOrgId() || null }, at }),
        this.#ports.holderId,
        at,
      );
      if (writer) {
        this.#patch({ createError: `This recording cannot be deleted. ${writer}` });
        return;
      }
      await store.delete(record.sessionId);
    } catch (caught) {
      this.#patch({ createError: describe(caught, "The recording could not be deleted.") });
    } finally {
      await this.refreshRecoverable();
    }
  }

  /**
   * D6 — the audio is released, and the record says why it is gone.
   *
   * The session transition goes through the queue (the single writer) so the
   * manifest is marked closed BEFORE the delete: a kill between the two leaves a
   * closed session that `resumable` will not offer back, which is the right way
   * round.
   */
  async #release(accepted: boolean): Promise<void> {
    const queue = this.#queue;
    if (!queue) return;
    this.#queue = null;
    this.#cancelWake();
    const sessionId = queue.session.id;
    this.#revokePreview();
    // The actor, so the shared transition can tell "the writer is closing its
    // own recording" from "somebody else is closing one that is being written".
    const by = { holderId: this.#ports.holderId };
    try {
      await queue.apply((session) => (
        accepted ? finalizeCapture(session, this.#instant(), by) : discardCaptureSession(session, this.#instant(), by)
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
      this.#claim = null;
      this.#stopHeartbeat();
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
   */
  async previewCapture(record: CaptureSessionRecord): Promise<void> {
    if (this.#previewRef?.sessionId === record.sessionId) {
      this.#revokePreview();
      return;
    }
    this.#patch({ busy: "preview" });
    try {
      const store = await this.#store(false);
      const { mimeType } = parseCapturePayload(record.payload);
      const audio = await store.readAudio(record.sessionId, mimeType || DEFAULT_CAPTURE_MIME_TYPE);
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
    // false for TWO stretches either side of the meeting.
    const captureInFlight = this.#state.recording || this.#arming || this.#active !== null;
    if (captureInFlight || this.#state.busy || this.#ports.otherBusy()) {
      this.#patch({
        createError: this.#state.recording
          ? "Stop the recording before creating the meeting — creating it releases the captured audio, and the chunk being written right now would have nowhere to land."
          : captureInFlight
            ? "The end of this recording is still being written to this device — creating the meeting now would release its audio while the last piece is still in flight. This takes a moment."
            : "Something else is still running here — try again in a moment.",
      });
      return;
    }
    const queue = this.#queue;
    // …and the lease, which is the term the other three cannot see: another tab
    // may have taken this recording over, and finalizing from here would delete
    // audio it is still writing.
    const stolen = queue ? describeCaptureWriter(queue.session, this.#ports.holderId, this.#instant()) : null;
    if (stolen) {
      this.#patch({ createError: `This meeting cannot be created from this tab. ${stolen}` });
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
   * recorder writing chunks through a closure nothing can reach any more, a
   * lease that would keep the meeting unofferable for the whole staleness
   * window, and an object URL over an hour of audio.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelWake();
    this.#stopHeartbeat();
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
      // lease release happen. Awaited so a caller — a test, or a host that has a
      // moment — can know the recording landed.
      await this.#finishing;
    } else {
      this.#microphone?.release();
      // No recorder, but possibly a picked-up capture whose queue is still
      // draining into it: hand the lease back so the next load offers it at once
      // instead of after the staleness window.
      await this.#releaseLease();
    }
    this.#microphone = null;
    this.#patch({ recording: false, paused: false });
  }

  /** Hand the recording back without closing it — the pick-up case at teardown. */
  async #releaseLease(): Promise<void> {
    const queue = this.#queue;
    const claim = this.#claim;
    if (!queue || !claim) return;
    this.#claim = null;
    try {
      await queue.apply((session) => {
        const released = releaseCaptureLease(session, claim, this.#instant());
        return released.ok ? released.session : session;
      });
    } catch {
      // Expiry is the mechanism that can be trusted; this is the optimisation.
    }
  }

  // ————————————————————————————————————————————————————————————— plumbing

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

  /** Remember one chunk's write until it lands, so Stop can wait for it. */
  #trackChunk(work: Promise<void>): void {
    this.#chunkWork.add(work);
    void work.finally(() => this.#chunkWork.delete(work));
  }

  /**
   * Wait for every chunk handler in flight, twice.
   *
   * Twice because the recorder can deliver its final chunk while the first pass
   * is already running — which is precisely the case this exists for — and never
   * more, because a drain must not be somewhere a producer can hang Stop for
   * ever. Rejections are absorbed: a chunk that failed to write has already
   * reported itself, and Stop must still settle the meeting.
   */
  async #settleChunks(): Promise<void> {
    for (let pass = 0; pass < 2 && this.#chunkWork.size; pass += 1) {
      await Promise.allSettled([...this.#chunkWork]);
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
    for (const listener of this.#listeners) listener();
  }
}
