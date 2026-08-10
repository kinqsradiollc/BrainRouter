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
 * The compose DRAFT crosses the same bridge for D6's reason rather than D1's:
 * "the existing text draft should move to the same protected location". There is
 * deliberately no `localStorage` fallback for it — falling back would be writing
 * meeting content to the store D6 named, which is the defect, not the degraded
 * mode.
 */
import type {
  MeetingCaptureScope,
  MeetingCaptureSession,
  MeetingCaptureTemplate,
  MeetingDrainPhase,
  MeetingRecoverySummary,
} from "@kinqs/brainrouter-core/meetings";

/** The queue phases main may push. Listed so an unknown one is dropped rather than rendered. */
const DRAIN_PHASES: readonly MeetingDrainPhase[] = ["idle", "waiting", "unavailable", "closed"];

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
   * §6 — segment indices the store could not read back, so the player can say
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
}

interface CaptureBridge {
  captureBegin?(input: { title?: string; template?: string; language?: string; orgId?: string | null; workspaceId?: string | null; contentType?: string }): Promise<unknown>;
  captureAppend?(id: string, bytes: Uint8Array, durationMs: number): Promise<unknown>;
  captureStop?(id: string): Promise<unknown>;
  captureRead?(id: string): Promise<unknown>;
  captureFinalize?(id: string): Promise<unknown>;
  captureDiscard?(id: string): Promise<unknown>;
  captureResumable?(scope?: { orgId?: string | null; workspaceId?: string | null }): Promise<unknown>;
  captureAdopt?(id: string): Promise<unknown>;
  captureRetrySegment?(id: string, index: number): Promise<unknown>;
  onCaptureProgress?(listener: (progress: unknown) => void): () => void;
  draftRead?(): Promise<unknown>;
  draftWrite?(draft: { title?: string; transcript?: string; template?: string; language?: string }): Promise<unknown>;
  draftClear?(): Promise<unknown>;
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
  // A host that predates the per-segment guard reports nothing here, which reads
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

function unavailable(): never { throw new MeetingCaptureUnavailableError(); }

export function createMeetingCaptureOps(): MeetingCaptureOps {
  const api = bridge();
  if (!api) {
    return {
      available: false,
      begin: async () => unavailable(), append: async () => unavailable(), stop: async () => unavailable(),
      read: async () => unavailable(), finalize: async () => unavailable(), discard: async () => unavailable(),
      adopt: async () => unavailable(), retrySegment: async () => unavailable(),
      // Nothing can ever be published on a build with no capture store, so the
      // subscription is a no-op rather than a throw: a surface that only listens
      // should not have to guard against a channel that will simply stay quiet.
      onProgress: () => () => undefined,
      // A build with no capture store has no captures to offer back, so an empty
      // recovery list is the truthful answer rather than an error banner.
      resumable: async () => [],
      // D6 — no protected location, so no draft. This is the one place a
      // `localStorage` fallback would be tempting and it is exactly the store
      // the decision moved the draft OUT of, so the honest degraded mode is a
      // compose form that does not persist rather than one that persists
      // somewhere it must not.
      draftAvailable: false,
      readDraft: async () => null,
      writeDraft: async () => undefined,
      clearDraft: async () => undefined,
    };
  }
  return {
    available: true,
    begin: async (input) => session(await api.captureBegin!({
      ...(input.title ? { title: input.title } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      orgId: input.scope.orgId,
      workspaceId: input.scope.workspaceId ?? null,
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
      return session(await api.captureAdopt(id));
    },
    retrySegment: async (id, index) => {
      if (!api.captureRetrySegment) unavailable();
      return session(await api.captureRetrySegment(id, index));
    },
    onProgress: (listener) => api.onCaptureProgress?.((value) => {
      const progress = (value ?? {}) as { sessionId?: unknown; session?: unknown; phase?: unknown; errors?: unknown };
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
      listener({
        sessionId: progress.sessionId,
        session: payload,
        ...(phase ? { phase } : {}),
        ...(errors.length ? { errors } : {}),
      });
    }) ?? (() => undefined),
    finalize: async (id) => { await api.captureFinalize?.(id); },
    discard: async (id) => { await api.captureDiscard?.(id); },
    resumable: async (scope, options) => {
      const value = await api.captureResumable?.({ orgId: scope.orgId, workspaceId: scope.workspaceId ?? null });
      const rows = Array.isArray(value) ? value as MeetingRecoverySummary[] : [];
      const excluded = new Set(options?.exclude ?? []);
      return excluded.size ? rows.filter((row) => !excluded.has(row.sessionId)) : rows;
    },
    // D6 — absent on a preload that predates the draft channels. Unlike the
    // capture channels this degrades quietly rather than refusing: a draft that
    // does not persist costs a retype, while a recording that does not persist
    // is the meeting itself.
    draftAvailable: Boolean(api.draftWrite),
    readDraft: async () => api.draftRead ? draft(await api.draftRead()) : null,
    writeDraft: async (value) => { await api.draftWrite?.(value); },
    clearDraft: async () => { await api.draftClear?.(); },
  };
}
