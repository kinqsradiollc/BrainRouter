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
  resumable(scope: MeetingCaptureScope): Promise<MeetingRecoverySummary[]>;
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
}

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
  const payload = (value ?? {}) as { bytes?: unknown; contentType?: unknown };
  // Structured clone can deliver either shape depending on how main produced it.
  // The assertion on the view states the one thing the compiler cannot see: a
  // `Uint8Array` that arrived over IPC is never backed by a `SharedArrayBuffer`
  // — main read it out of a file — and asserting it here beats copying the whole
  // recording at the playback site just to change its type.
  const bytes = payload.bytes instanceof Uint8Array
    ? payload.bytes as Uint8Array<ArrayBuffer>
    : payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : null;
  if (!bytes) throw new Error("The capture store returned no audio for that meeting.");
  return { bytes, contentType: typeof payload.contentType === "string" && payload.contentType ? payload.contentType : "audio/webm" };
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
    resumable: async (scope) => {
      const value = await api.captureResumable?.({ orgId: scope.orgId, workspaceId: scope.workspaceId ?? null });
      return Array.isArray(value) ? value as MeetingRecoverySummary[] : [];
    },
  };
}
