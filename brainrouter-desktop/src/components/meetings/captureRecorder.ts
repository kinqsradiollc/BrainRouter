/**
 * ADR-035 D1 — the recorder that never holds a meeting.
 *
 * Two things here are the whole decision:
 *
 * 1. **The recorder is started with an explicit timeslice.** Without one,
 *    `MediaRecorder` is free to deliver a single blob at `stop`, and writing
 *    that blob to disk buys nothing — the crash it was meant to survive happens
 *    while the audio is still in the heap.
 * 2. **A chunk is handed to the host and then forgotten.** There is no array of
 *    blobs anywhere in this class. §1's defect was `chunksRef`, and the reliable
 *    way not to reintroduce it is to have nowhere to put a chunk.
 *
 * Writes are serialized through one promise chain because segment order is
 * meaningful: the shared model derives each segment's time range from the
 * previous one's end, so two overlapping appends would produce a transcript
 * whose gaps point at the wrong minute.
 *
 * Every collaborator is injectable — the media stream, the `MediaRecorder`, the
 * clock — so the cadence and the "nothing accumulates" property can be tested
 * without a microphone.
 */
import { DEFAULT_MEETING_SEGMENT_MS, type MeetingCaptureScope, type MeetingCaptureTemplate } from "@kinqs/brainrouter-core/meetings";
import type { MeetingCaptureOps } from "./captureOps.js";

export interface StartCaptureInput {
  scope: MeetingCaptureScope;
  title?: string;
  template?: MeetingCaptureTemplate;
  language?: string;
}

export interface MeetingCaptureRecorderOptions {
  capture: MeetingCaptureOps;
  /** Reported when a chunk could not be written — the user must not learn this at Stop. */
  onChunkError?: (message: string) => void;
  segmentMs?: number;
  openStream?: () => Promise<MediaStream>;
  createRecorder?: (stream: MediaStream) => MediaRecorder;
  now?: () => number;
}

export class MicrophoneUnavailableError extends Error {
  constructor() {
    super("Microphone access was denied or is unavailable.");
    this.name = "MicrophoneUnavailableError";
  }
}

export class MeetingCaptureRecorder {
  private readonly capture: MeetingCaptureOps;
  private readonly onChunkError: (message: string) => void;
  private readonly segmentMs: number;
  private readonly openStream: () => Promise<MediaStream>;
  private readonly createRecorder: (stream: MediaStream) => MediaRecorder;
  private readonly now: () => number;

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private sessionId: string | null = null;
  private lastChunkAt = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: MeetingCaptureRecorderOptions) {
    this.capture = options.capture;
    this.onChunkError = options.onChunkError ?? (() => undefined);
    this.segmentMs = options.segmentMs ?? DEFAULT_MEETING_SEGMENT_MS;
    this.openStream = options.openStream ?? (() => navigator.mediaDevices.getUserMedia({ audio: true }));
    this.createRecorder = options.createRecorder ?? ((stream) => new MediaRecorder(stream));
    this.now = options.now ?? (() => Date.now());
  }

  get paused(): boolean {
    return this.recorder?.state === "paused";
  }

  /**
   * D2 — the session (and its capture directory) exists before the first byte
   * does. The recorder is only started once the store has acknowledged it, so a
   * chunk can never arrive with nowhere to go.
   */
  async start(input: StartCaptureInput): Promise<string> {
    if (this.sessionId) throw new Error("A meeting is already being captured.");
    let stream: MediaStream;
    try { stream = await this.openStream(); }
    catch { throw new MicrophoneUnavailableError(); }

    let recorder: MediaRecorder;
    try { recorder = this.createRecorder(stream); }
    catch { stopTracks(stream); throw new MicrophoneUnavailableError(); }

    let sessionId: string;
    try {
      const session = await this.capture.begin({
        scope: input.scope,
        ...(input.title ? { title: input.title } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(recorder.mimeType ? { contentType: recorder.mimeType } : {}),
      });
      sessionId = session.id;
    } catch (caught) {
      stopTracks(stream);
      throw caught;
    }

    this.stream = stream;
    this.recorder = recorder;
    this.sessionId = sessionId;
    this.lastChunkAt = this.now();
    this.writes = Promise.resolve();
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size) this.enqueue(sessionId, event.data);
    };
    recorder.start(this.segmentMs);
    return sessionId;
  }

  pause(): void {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume(): void {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  /**
   * Stops the recorder, waits for the final chunk to be written, and only then
   * marks the capture stopped. Returning before the queue drains would let the
   * caller read audio that is missing its last segment.
   */
  async stop(): Promise<string | null> {
    const recorder = this.recorder;
    const sessionId = this.sessionId;
    this.recorder = null;
    this.sessionId = null;
    if (!recorder || !sessionId) {
      this.release();
      return null;
    }
    await new Promise<void>((resolve) => {
      if (recorder.state === "inactive") { resolve(); return; }
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    this.release();
    await this.settled();
    try { await this.capture.stop(sessionId); }
    catch (caught) { this.onChunkError(message(caught, "Could not close this recording.")); }
    return sessionId;
  }

  /** Unmount path: release the microphone and let the pending writes finish. */
  async dispose(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    this.sessionId = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    this.release();
    await this.settled();
  }

  /** Resolves once every queued chunk has been written (or failed). */
  async settled(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  private enqueue(sessionId: string, blob: Blob): void {
    const at = this.now();
    // Measured elapsed time, not the nominal timeslice: a paused or throttled
    // recorder delivers chunks late, and a segment's stated time range is what
    // a gap marker prints under D5.
    const durationMs = Math.max(1, Math.round(at - this.lastChunkAt));
    this.lastChunkAt = at;
    this.writes = this.writes.then(async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await this.capture.append(sessionId, bytes, durationMs);
      } catch (caught) {
        this.onChunkError(message(caught, "Part of this recording could not be saved to disk."));
      }
    }, () => undefined);
  }

  private release(): void {
    stopTracks(this.stream);
    this.stream = null;
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
