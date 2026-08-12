/**
 * ADR-035 D1/D2 — the renderer's typed view of the durable capture bridge.
 *
 * The renderer cannot write files, so this adapter is the whole of what "the
 * audio is safe" means on this side: every recorder chunk goes through `append`
 * and is on disk in the main process before the next one arrives. Nothing here
 * keeps audio — deliberately. §1's defect was a `chunksRef` that held an entire
 * meeting in the heap, and the only durable way to not have that bug again is to
 * have nowhere to put the bytes.
 *
 * `available` is false on a preload that predates these channels. Recording then
 * refuses rather than silently falling back to buffering in memory: a recording
 * that cannot be written down is the failure this ADR exists to end, and ADR-028
 * says the surface must say which state it is in instead of looking like it
 * worked.
 *
 * D10 rides the same bridge rather than a second one. The host owns the live
 * connection because a renderer-owned socket dies with the window — the defect
 * this ADR exists to end — so what arrives here is the same progress push with
 * two more facts on it: which transcription strategy the endpoint gave this
 * capture, and the utterances still being spoken. The second is the only part of
 * that payload which is not already on disk, and it deliberately never reaches
 * the compose box: settled text gets there through the shared fold, and a
 * revision that could overwrite an edit has nowhere to write.
 *
 * The compose DRAFT crosses the same bridge for D6's reason rather than D1's:
 * "the existing text draft should move to the same protected location". There is
 * deliberately no `localStorage` fallback for it — falling back would be writing
 * meeting content to the store D6 named, which is the defect, not the degraded
 * mode.
 */
import {
  describeMeetingRetention,
  MEETING_RETENTION_DAY_CHOICES,
  MEETING_RETENTION_DEFAULT_DAYS,
  normalizeMeetingRetentionDays,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingDrainPhase,
  type MeetingLiveUtterance,
  type MeetingRecoverySummary,
  type MeetingTranscriptionMode,
} from "@kinqs/brainrouter-core/meetings";
import { captureHolderId } from "./captureHolder.js";

/** The queue phases main may push. Listed so an unknown one is dropped rather than rendered. */
const DRAIN_PHASES: readonly MeetingDrainPhase[] = ["idle", "waiting", "unavailable", "closed"];

/** D10 — the two strategies. An unknown one is dropped, which reads as "main did not say". */
const TRANSCRIPTION_MODES: readonly MeetingTranscriptionMode[] = ["streaming", "segmented"];

/** Bounded because these are RENDERED: a runaway push must not become an unbounded list on screen. */
const MAX_LIVE_UTTERANCES = 64;

export interface BeginCaptureInput {
  title?: string;
  template?: MeetingCaptureTemplate;
  language?: string;
  scope: MeetingCaptureScope;
  /** The recorder's MIME type, so the bytes can be described truthfully on the way back. */
  contentType?: string;
}

export interface CapturedAudio {
  /**
   * Backed by a plain `ArrayBuffer`, not merely by an `ArrayBufferLike`, because
   * the only thing the renderer does with these bytes is put them in a `Blob` to
   * play them back (§6's "on disk and PLAYABLE"). `Blob` refuses a view over a
   * `SharedArrayBuffer`, so stating the buffer here is what keeps the playback
   * site from having to copy an hour of audio to satisfy the type.
   */
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  /**
   * §6 — saved-audio chunk sequences the store could not read back, so the player can say
   * that what it is playing is short of the recording rather than pretend it is
   * the whole thing. Empty on a healthy capture, which is every capture that has
   * not lost a file.
   */
  missing: readonly number[];
}

/**
 * D4 — a capture's record changed in main, and it is already on disk.
 *
 * Except when `errors` is present, which is the push that exists BECAUSE a write
 * failed. A surface that renders the session and drops the errors is telling the
 * user their meeting is safe on the strength of a message that says it is not.
 */
export interface MeetingCaptureProgress {
  sessionId: string;
  session: MeetingCaptureSession;
  /** D4/D7 — why the host's queue last stopped. Absent on mid-drain pushes. */
  phase?: MeetingDrainPhase;
  errors?: readonly string[];
  /**
   * D10 — which transcription strategy this capture is on, and the sentence
   * saying why.
   *
   * Absent on the pushes that do not change it, so a surface keeps the last
   * answer. It exists because golden rule 23 makes a silent degradation the
   * defect: a meeting transcribed in segments because live transcription was
   * refused must not look identical to one that never asked.
   */
  transcription?: MeetingTranscriptionStatus;
  /**
   * D4/D10 — provisional text, mid-utterance, and the one part of this payload
   * that is NOT on disk.
   *
   * It is display-only and never enters the compose box: the shared
   * `transcriptFold` appends settled segments, and a person's edit cannot be
   * overwritten by a revision that has nowhere to write. A committed utterance
   * arrives again as a `done` segment, which is what the box gets.
   */
  live?: readonly MeetingLiveUtterance[];
}

/** D10 — the wire shape of `MeetingTranscriptionStatus` in `electron/meetingStreamSession.ts`. */
export interface MeetingTranscriptionStatus {
  mode: MeetingTranscriptionMode;
  live: boolean;
  /** Composed in main, so the words a fallback is described with are one sentence, not two copies. */
  notice: string;
}

/**
 * D6 — a capture some window in this process is recording into right now.
 *
 * The wire shape of `MeetingCaptureWriter` in `electron/meetingTranscription.ts`,
 * restated here because the renderer bundle must not reach into main. It carries
 * no time, no term and no expiry, because there is nothing to expire: main holds
 * every window, so this row exists exactly while a recorder is feeding that
 * capture.
 *
 * `note` is the sentence to show, composed by main so that the words a
 * destructive channel throws and the words a second window prints are the same
 * words. It is only ever shown for a row whose `holderId` is not this window's.
 */
export interface MeetingCaptureWriter {
  sessionId: string;
  holderId: string;
  note: string;
}

/**
 * D6 — what the compose form holds that is not audio.
 *
 * `transcript` is the text a PERSON owns: pasted, typed, or edited. The settled
 * words of a live capture are not mirrored into it — they are already durable in
 * the capture record, and a second copy of them in a restorable draft is both a
 * retention surface and the reason a recovered meeting used to be summarized
 * twice.
 */
export interface MeetingComposeDraft {
  title: string;
  transcript: string;
  template?: MeetingCaptureTemplate;
  language?: string;
}

/**
 * F1 — what a recovery offer must leave out, and why the store cannot work it
 * out for itself.
 *
 * D2's predicate is "audio present, no terminal state", and `isResumableSession`
 * deliberately does not narrow on `recording`: a session a clean quit left
 * behind still holds audio that never transcribed, and D7 says it should drain
 * when the endpoint returns. That is right, and it means the RECORDING BEING
 * MADE RIGHT NOW satisfies the predicate too — so the library offered to
 * "transcribe it, or delete it" while the microphone was still open.
 *
 * Only the window that owns the recorder knows which session that is, so it is
 * the window that says. The filter is applied here rather than across the
 * bridge for the same reason: main can see every capture on the device and none
 * of the windows holding one. (The dashboard passes the same `exclude` into
 * `resumableCaptures`, which is where ITS store lives — D1b, one rule, each
 * host's own boundary.)
 */
export interface ResumableCaptureOptions {
  /** Ids to leave out whatever the store says — in practice the capture in hand. */
  readonly exclude?: readonly string[];
}

export interface MeetingCaptureOps {
  /** False when this build's preload has no capture channels — see the module header. */
  readonly available: boolean;
  begin(input: BeginCaptureInput): Promise<MeetingCaptureSession>;
  append(id: string, bytes: Uint8Array, durationMs: number): Promise<MeetingCaptureSession>;
  stop(id: string): Promise<MeetingCaptureSession>;
  read(id: string): Promise<CapturedAudio>;
  /** D3 — ask the host to drive this capture's segment queue, and say where it is now. */
  adopt(id: string): Promise<MeetingCaptureSession>;
  /** D5 — one more attempt at one stated gap, from the audio still on disk. */
  retrySegment(id: string, index: number): Promise<MeetingCaptureSession>;
  /** D4 — subscribe to the host's progress. Returns the unsubscribe. */
  onProgress(listener: (progress: MeetingCaptureProgress) => void): () => void;
  finalize(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  resumable(scope: MeetingCaptureScope, options?: ResumableCaptureOptions): Promise<MeetingRecoverySummary[]>;
  /**
   * D6 — the captures somebody is recording into right now, whichever window
   * that is.
   *
   * The offer's complement. `resumableSessions` leaves a live recording out, so
   * without this a second window has nothing to render where the meeting it can
   * hear being recorded ought to be. Rows for EVERY window including this one:
   * the caller compares `holderId` against its own, because "is this me?" is the
   * difference between a panel that explains something and a panel that tells
   * you that you are recording.
   */
  writing(scope: MeetingCaptureScope): Promise<readonly MeetingCaptureWriter[]>;
  /**
   * D6 — the host's push that the answer above has changed. Returns the
   * unsubscribe.
   *
   * The compensating re-check, and the reason a stale answer is not a permanent
   * one: a second window learns that a recording ENDED at the instant it ends
   * rather than by asking again for reasons of its own. It carries no payload —
   * the row set is per workspace and per window, so the caller asks.
   */
  onWriters(listener: () => void): () => void;
  /** This window's writer identity — the same one every call above sends. */
  readonly holderId: string;
  /**
   * D6 — whether this preload can actually take a draft.
   *
   * `writeDraft` resolves either way, because a compose form that refuses to
   * persist is worse than one that quietly does not. The MIGRATION out of
   * `localStorage` is the one caller that must know the difference: it deletes
   * the only copy of the words, so "the write was a no-op" and "the words are
   * now in the protected file" cannot be the same answer to it.
   */
  readonly draftAvailable: boolean;
  /** D6 — the compose draft, held by the host. `null` when there is nothing to restore. */
  readDraft(): Promise<MeetingComposeDraft | null>;
  writeDraft(draft: MeetingComposeDraft): Promise<void>;
  clearDraft(): Promise<void>;
  /**
   * D6 — whether this preload can change the retention window.
   *
   * Separate from `available` because it degrades differently: a build with no
   * capture channels cannot record at all, while one that predates these two
   * still records and sweeps by the built-in default — it just cannot be told a
   * different number. The surface shows the window either way and hides only the
   * control, because a disabled control over a policy that IS in force reads as
   * "no retention", which is the opposite of the truth.
   */
  readonly retentionAvailable: boolean;
  /** D6 — the window in force, the ladder to offer, and the sentence that describes it. */
  readRetention(): Promise<MeetingRetentionSetting>;
  /** D6 — set the window and sweep now. `deleted` is how many recordings that removed. */
  writeRetention(days: number): Promise<MeetingRetentionSetting>;
}

/**
 * D6 — the retention window as a surface renders it.
 *
 * `description` and `choices` come from the host rather than being composed
 * here, because both belong to the shared rule (`retention.ts`): the browser
 * shows the same ladder and prints the same sentence, and two hosts wording one
 * policy independently is how they come to describe two policies.
 *
 * `deleted` is present only on the answer to a WRITE, and it is the difference
 * between a setting and a promise kept: shortening the window to a day and being
 * told nothing is what a control that does not sweep also looks like.
 */
export interface MeetingRetentionSetting {
  days: number;
  choices: readonly number[];
  description: string;
  deleted?: number;
}

interface CaptureBridge {
  captureBegin?(input: { title?: string; template?: string; language?: string; orgId?: string | null; workspaceId?: string | null; contentType?: string; holderId?: string }): Promise<unknown>;
  captureAppend?(id: string, bytes: Uint8Array, durationMs: number): Promise<unknown>;
  captureStop?(id: string): Promise<unknown>;
  captureRead?(id: string): Promise<unknown>;
  captureFinalize?(id: string, holderId?: string): Promise<unknown>;
  captureDiscard?(id: string, holderId?: string): Promise<unknown>;
  captureResumable?(scope?: { orgId?: string | null; workspaceId?: string | null }): Promise<unknown>;
  captureWriting?(scope?: { orgId?: string | null; workspaceId?: string | null }): Promise<unknown>;
  captureAdopt?(id: string, holderId?: string): Promise<unknown>;
  captureRetrySegment?(id: string, index: number): Promise<unknown>;
  onCaptureProgress?(listener: (progress: unknown) => void): () => void;
  onCaptureWriters?(listener: () => void): () => void;
  draftRead?(): Promise<unknown>;
  draftWrite?(draft: { title?: string; transcript?: string; template?: string; language?: string }): Promise<unknown>;
  draftClear?(): Promise<unknown>;
  retentionRead?(): Promise<unknown>;
  retentionWrite?(days: number): Promise<unknown>;
}

const TEMPLATES: readonly MeetingCaptureTemplate[] = ["general", "standup", "one-on-one", "retrospective"];

export class MeetingCaptureUnavailableError extends Error {
  constructor() {
    super("This build cannot store meeting audio safely. Restart BrainRouter after updating the desktop app.");
    this.name = "MeetingCaptureUnavailableError";
  }
}

function bridge(): CaptureBridge | null {
  const root = globalThis as unknown as { brainrouter?: { meetings?: CaptureBridge } };
  const api = root.brainrouter?.meetings;
  return api?.captureBegin && api.captureAppend ? api : null;
}

function session(value: unknown): MeetingCaptureSession {
  if (!value || typeof value !== "object" || !Array.isArray((value as MeetingCaptureSession).segments)) {
    throw new Error("The capture store returned an invalid meeting session.");
  }
  return value as MeetingCaptureSession;
}

function audio(value: unknown): CapturedAudio {
  const payload = (value ?? {}) as { bytes?: unknown; contentType?: unknown; missing?: unknown };
  // Structured clone can deliver either shape depending on how main produced it.
  // The assertion on the view states the one thing the compiler cannot see: a
  // `Uint8Array` that arrived over IPC is never backed by a `SharedArrayBuffer`
  // — main read it out of a file — and asserting it here beats copying the whole
  // recording at the playback site just to change its type.
  const bytes = payload.bytes instanceof Uint8Array
    ? payload.bytes as Uint8Array<ArrayBuffer>
    : payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : null;
  if (!bytes) throw new Error("The capture store returned no audio for that meeting.");
  // A host that predates the per-chunk guard reports nothing here, which reads
  // as "nothing was missing" — the same answer it used to give by rejecting, but
  // without taking the rest of the recording down with it.
  const missing = Array.isArray(payload.missing)
    ? payload.missing.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
    : [];
  return { bytes, contentType: typeof payload.contentType === "string" && payload.contentType ? payload.contentType : "audio/webm", missing };
}

/**
 * The host's answer, re-validated on the way in.
 *
 * The draft file outlives app versions and the surface renders it straight into
 * the compose form, so a record written by some other version is narrowed here
 * rather than trusted.
 */
function draft(value: unknown): MeetingComposeDraft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { title?: unknown; transcript?: unknown; template?: unknown; language?: unknown };
  const title = typeof raw.title === "string" ? raw.title : "";
  const transcript = typeof raw.transcript === "string" ? raw.transcript : "";
  if (!title && !transcript) return null;
  const template = TEMPLATES.find((candidate) => candidate === raw.template);
  const language = typeof raw.language === "string" && raw.language.trim() ? raw.language.trim() : undefined;
  return { title, transcript, ...(template ? { template } : {}), ...(language ? { language } : {}) };
}

/**
 * D10 — main's answer about which path is running, re-validated on the way in.
 *
 * Every field is load-bearing and every field is rendered, so a row missing one
 * is dropped whole rather than shown half: a status with no `notice` is exactly
 * the silent degradation golden rule 23 is about, wearing a badge.
 */
function transcriptionStatus(value: unknown): MeetingTranscriptionStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { mode?: unknown; live?: unknown; notice?: unknown };
  const mode = TRANSCRIPTION_MODES.find((candidate) => candidate === raw.mode);
  if (!mode || typeof raw.live !== "boolean" || typeof raw.notice !== "string") return null;
  return { mode, live: raw.live, notice: raw.notice };
}

/**
 * D4/D10 — the provisional utterances, narrowed and bounded.
 *
 * `null` means "this push said nothing about live text", which is not the same
 * as an empty list: an empty list is main saying the live buffer is now empty
 * (everything committed), and clearing the rows is the right answer to it.
 */
function liveUtterances(value: unknown): readonly MeetingLiveUtterance[] | null {
  if (!Array.isArray(value)) return null;
  const rows: MeetingLiveUtterance[] = [];
  for (const entry of value.slice(0, MAX_LIVE_UTTERANCES)) {
    const raw = entry as Partial<MeetingLiveUtterance> | null;
    if (!raw || typeof raw.utteranceId !== "string" || !raw.utteranceId) continue;
    if (typeof raw.text !== "string" || typeof raw.startMs !== "number" || typeof raw.endMs !== "number") continue;
    if (raw.state !== "partial" && raw.state !== "final") continue;
    if (raw.kind !== raw.state || typeof raw.revision !== "number") continue;
    rows.push({
      kind: raw.state,
      state: raw.state,
      utteranceId: raw.utteranceId,
      revision: raw.revision,
      text: raw.text,
      startMs: raw.startMs,
      endMs: raw.endMs,
    } as MeetingLiveUtterance);
  }
  return rows;
}

/**
 * D6 — the host's retention answer, re-validated on the way in.
 *
 * A host that says nothing usable is not a host with no retention policy: the
 * store's own default is already in force and the sweep is already running by
 * it. So the fallback is the SHARED default with the shared sentence, which is
 * what will actually happen — rendering "unknown" here would be the surface
 * disclaiming a deletion the device is going to perform anyway.
 */
function retentionSetting(value: unknown): MeetingRetentionSetting {
  const raw = (value ?? {}) as { days?: unknown; choices?: unknown; description?: unknown; deleted?: unknown };
  const days = normalizeMeetingRetentionDays(typeof raw.days === "number" ? raw.days : MEETING_RETENTION_DEFAULT_DAYS);
  const choices = Array.isArray(raw.choices)
    ? raw.choices.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
    : [];
  const deleted = typeof raw.deleted === "number" && Number.isInteger(raw.deleted) && raw.deleted >= 0 ? raw.deleted : undefined;
  return {
    days,
    choices: choices.length ? choices : MEETING_RETENTION_DAY_CHOICES,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description : describeMeetingRetention(days),
    ...(deleted === undefined ? {} : { deleted }),
  };
}

function unavailable(): never { throw new MeetingCaptureUnavailableError(); }

export function createMeetingCaptureOps(): MeetingCaptureOps {
  const api = bridge();
  // Read once, here, so every call this adapter makes carries the same window
  // identity — and so the surface can compare a record's writer against it.
  const holderId = captureHolderId();
  if (!api) {
    return {
      available: false,
      holderId,
      begin: async () => unavailable(), append: async () => unavailable(), stop: async () => unavailable(),
      read: async () => unavailable(), finalize: async () => unavailable(), discard: async () => unavailable(),
      adopt: async () => unavailable(), retrySegment: async () => unavailable(),
      // Nothing can ever be published on a build with no capture store, so the
      // subscription is a no-op rather than a throw: a surface that only listens
      // should not have to guard against a channel that will simply stay quiet.
      onProgress: () => () => undefined,
      // A build with no capture store has no captures to offer back, so an empty
      // recovery list is the truthful answer rather than an error banner. Nor is
      // anything being recorded into it, for the same reason.
      resumable: async () => [],
      writing: async () => [],
      onWriters: () => () => undefined,
      // D6 — no protected location, so no draft. This is the one place a
      // `localStorage` fallback would be tempting and it is exactly the store
      // the decision moved the draft OUT of, so the honest degraded mode is a
      // compose form that does not persist rather than one that persists
      // somewhere it must not.
      draftAvailable: false,
      readDraft: async () => null,
      writeDraft: async () => undefined,
      clearDraft: async () => undefined,
      // No capture store means no captured audio, so there is nothing for a
      // window to apply. The shared default is still what this build would
      // sweep by if it could record, which is the truthful thing to show.
      retentionAvailable: false,
      readRetention: async () => retentionSetting({}),
      writeRetention: async () => retentionSetting({}),
    };
  }
  return {
    available: true,
    holderId,
    begin: async (input) => session(await api.captureBegin!({
      ...(input.title ? { title: input.title } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      orgId: input.scope.orgId,
      workspaceId: input.scope.workspaceId ?? null,
      // D6 — main registers this window as the capture's writer from the moment
      // the capture exists, before the first byte of audio does.
      //
      // Nothing about this id is WRITTEN DOWN. `MeetingCaptureStore.begin` never
      // sees it: the supervisor puts it in a map that lives in the one process
      // every window lives in, and `MeetingCaptureSession` has no `writer` field
      // to put it in — deliberately, and at length (`types.ts`). A name in the
      // record outlives the writer it named, which is the staleness that made
      // §6's own destructive test fail.
      holderId,
    })),
    append: async (id, bytes, durationMs) => session(await api.captureAppend!(id, bytes, durationMs)),
    stop: async (id) => session(await api.captureStop!(id)),
    read: async (id) => audio(await api.captureRead?.(id)),
    // D3 — these three arrived after the first capture channels did, so a
    // preload that predates them is refused loudly rather than silently doing
    // nothing: "the transcript never appears" is the failure mode this ADR is
    // about, and it must not be reachable by a stale window.
    adopt: async (id) => {
      if (!api.captureAdopt) unavailable();
      // D6 — a pick-up REGISTERS NO WRITER, so this id is not a claim: it is the
      // identity main compares against the writer it already has. Nobody is
      // producing audio for a capture being picked up, and claiming otherwise
      // would hide it from every other window for as long as this one lived.
      // What sending it buys is the refusal — main throws while a DIFFERENT
      // window is recording this capture, and that rejection is what reaches the
      // compose form instead of a meeting somebody else is making.
      return session(await api.captureAdopt(id, holderId));
    },
    retrySegment: async (id, index) => {
      if (!api.captureRetrySegment) unavailable();
      return session(await api.captureRetrySegment(id, index));
    },
    onProgress: (listener) => api.onCaptureProgress?.((value) => {
      const progress = (value ?? {}) as { sessionId?: unknown; session?: unknown; phase?: unknown; errors?: unknown; transcription?: unknown; live?: unknown };
      const payload = progress.session as MeetingCaptureSession | undefined;
      // A malformed push is dropped rather than thrown: this runs inside an IPC
      // listener, where a throw would take out every later event on the channel.
      if (typeof progress.sessionId !== "string" || !payload || !Array.isArray(payload.segments)) return;
      // Errors are narrowed to strings because they are RENDERED: a non-string
      // that got this far would reach the user as "[object Object]", which is a
      // worse way to report a durability failure than not reporting it.
      const errors = Array.isArray(progress.errors)
        ? progress.errors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      const phase = DRAIN_PHASES.find((candidate) => candidate === progress.phase);
      const transcription = transcriptionStatus(progress.transcription);
      const live = liveUtterances(progress.live);
      listener({
        sessionId: progress.sessionId,
        session: payload,
        ...(phase ? { phase } : {}),
        ...(errors.length ? { errors } : {}),
        ...(transcription ? { transcription } : {}),
        ...(live ? { live } : {}),
      });
    }) ?? (() => undefined),
    // D6 — both of these delete the audio, so both name this window. Main uses
    // it to tell "the window that recorded this" from "a second window looking
    // at a stale offer", and refuses the second one.
    finalize: async (id) => { await api.captureFinalize?.(id, holderId); },
    discard: async (id) => { await api.captureDiscard?.(id, holderId); },
    resumable: async (scope, options) => {
      const value = await api.captureResumable?.({ orgId: scope.orgId, workspaceId: scope.workspaceId ?? null });
      const rows = Array.isArray(value) ? value as MeetingRecoverySummary[] : [];
      const excluded = new Set(options?.exclude ?? []);
      return excluded.size ? rows.filter((row) => !excluded.has(row.sessionId)) : rows;
    },
    // A preload that predates this channel answers nothing, which reads as "no
    // window is recording". That is the same answer this surface gave before any
    // of this existed, so an old preload degrades to the old behaviour rather
    // than to an error over a feature it cannot participate in.
    writing: async (scope) => {
      const value = await api.captureWriting?.({ orgId: scope.orgId, workspaceId: scope.workspaceId ?? null });
      if (!Array.isArray(value)) return [];
      // Each field is checked because all three are LOAD-BEARING: the id decides
      // which controls are locked, the holder decides whether this window is the
      // one being told, and the note is rendered. A row missing any of them
      // would silently unlock a destructive control over a live recording.
      return value.filter((row): row is MeetingCaptureWriter => {
        const candidate = row as Partial<MeetingCaptureWriter> | null;
        return Boolean(candidate) && typeof candidate?.sessionId === "string" && Boolean(candidate.sessionId)
          && typeof candidate.holderId === "string" && Boolean(candidate.holderId)
          && typeof candidate.note === "string" && Boolean(candidate.note.trim());
      });
    },
    onWriters: (listener) => api.onCaptureWriters?.(listener) ?? (() => undefined),
    // D6 — absent on a preload that predates the draft channels. Unlike the
    // capture channels this degrades quietly rather than refusing: a draft that
    // does not persist costs a retype, while a recording that does not persist
    // is the meeting itself.
    draftAvailable: Boolean(api.draftWrite),
    readDraft: async () => api.draftRead ? draft(await api.draftRead()) : null,
    writeDraft: async (value) => { await api.draftWrite?.(value); },
    clearDraft: async () => { await api.draftClear?.(); },
    // D6 — the WRITE channel is what makes the control usable; a preload with
    // only the read still shows the window that is in force.
    retentionAvailable: Boolean(api.retentionWrite),
    readRetention: async () => retentionSetting(api.retentionRead ? await api.retentionRead() : {}),
    writeRetention: async (days) => {
      // Normalized on the way out as well as in main. The host is the authority
      // and re-normalizes, but a surface that sent 5,000 and rendered 5,000 back
      // from its own optimism would show a window nothing enforces.
      if (!api.retentionWrite) return retentionSetting(api.retentionRead ? await api.retentionRead() : {});
      return retentionSetting(await api.retentionWrite(normalizeMeetingRetentionDays(days)));
    },
  };
}
