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
  MeetingRecoverySummary,
} from "@kinqs/brainrouter-core/meetings";

export interface BeginCaptureInput {
  title?: string;
  template?: MeetingCaptureTemplate;
  language?: string;
  scope: MeetingCaptureScope;
  /** The recorder's MIME type, so the bytes can be described truthfully on the way back. */
  contentType?: string;
}

export interface CapturedAudio {
  bytes: Uint8Array;
  contentType: string;
}

export interface MeetingCaptureOps {
  /** False when this build's preload has no capture channels — see the module header. */
  readonly available: boolean;
  begin(input: BeginCaptureInput): Promise<MeetingCaptureSession>;
  append(id: string, bytes: Uint8Array, durationMs: number): Promise<MeetingCaptureSession>;
  stop(id: string): Promise<MeetingCaptureSession>;
  read(id: string): Promise<CapturedAudio>;
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
  const bytes = payload.bytes instanceof Uint8Array
    ? payload.bytes
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
    finalize: async (id) => { await api.captureFinalize?.(id); },
    discard: async (id) => { await api.captureDiscard?.(id); },
    resumable: async (scope) => {
      const value = await api.captureResumable?.({ orgId: scope.orgId, workspaceId: scope.workspaceId ?? null });
      return Array.isArray(value) ? value as MeetingRecoverySummary[] : [];
    },
  };
}
