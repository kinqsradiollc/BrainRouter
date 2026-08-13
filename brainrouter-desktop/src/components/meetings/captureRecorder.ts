/**
 * ADR-035 D1/D9 — the recorder that never holds a meeting.
 *
 * Two things here are the whole decision:
 *
 * 1. **The recorder is started with an explicit durability timeslice.** Without one,
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
 * **`start` is cancellable, and that is a third decision rather than a detail.**
 * It crosses two awaits — the microphone, then the store — and
 * `getUserMedia` can sit on a permission prompt for as long as the person takes
 * to answer it. A caller that tore this recorder down during that stretch used
 * to be ignored: the microphone opened anyway, the recorder started on a view
 * that no longer existed, chunks went on being written, and main went on
 * claiming the capture under that window's holder id for the life of the
 * process — filtered out of every window's offer, dropped from its own writers
 * panel as "mine", and refused to every other window. Invisible and
 * unstoppable. So `stop` marks the attempt abandoned and `start` checks after
 * each await: nothing runs, and nothing stays claimed.
 *
 * Every collaborator is injectable — the media stream, the `MediaRecorder`, the
 * clock — so the cadence and the "nothing accumulates" property can be tested
 * without a microphone.
 */
import {
  DEFAULT_MEETING_CHUNK_MS,
  meetingRecorderOptions,
  type MeetingCaptureScope,
  type MeetingCaptureTemplate,
} from "@kinqs/brainrouter-core/meetings";
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
  /** D9 — how often bytes become durable. This does not choose transcription-unit boundaries. */
  chunkMs?: number;
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

/**
 * `start` was abandoned before the recorder was running — the caller called
 * `stop` while the microphone prompt was still up.
 *
 * Its own type rather than a generic failure because the two mean opposite
 * things to a surface: `MicrophoneUnavailableError` is something the user has to
 * be told about, and this is the user's own decision already carried out. A
 * banner saying "Could not start recording" over a recording nobody wanted is
 * ADR-028's complaint in miniature.
 */
export class CaptureCancelledError extends Error {
  constructor() {
    super("That recording was stopped before it started.");
    this.name = "CaptureCancelledError";
  }
}

export class MeetingCaptureRecorder {
  private readonly capture: MeetingCaptureOps;
  private readonly onChunkError: (message: string) => void;
  private readonly chunkMs: number;
  private readonly openStream: () => Promise<MediaStream>;
  private readonly createRecorder: (stream: MediaStream) => MediaRecorder;
  private readonly now: () => number;

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private sessionId: string | null = null;
  private lastChunkAt = 0;
  /** Wall-clock instant at which active capture stopped, excluded from the next chunk's range. */
  private pausedAt: number | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  /**
   * Which attempt to start is the current one.
   *
   * Bumped by `stop`, and compared by `start` across each of its awaits. A flag
   * would not do: `stop` also has to leave this object usable, because the same
   * recorder is reused for the next Record — so what is cancelled is one
   * ATTEMPT, not the recorder.
   */
  private attempt = 0;

  constructor(options: MeetingCaptureRecorderOptions) {
    this.capture = options.capture;
    this.onChunkError = options.onChunkError ?? (() => undefined);
    this.chunkMs = options.chunkMs ?? DEFAULT_MEETING_CHUNK_MS;
    this.openStream = options.openStream ?? (() => navigator.mediaDevices.getUserMedia({ audio: true }));
    // D11 — at a SPEECH bitrate. Constructed with no options this was the
    // browser's default, roughly 128 kbps and about 60 MB an hour, and every
    // number that matters about a recording is downstream of that one: what a
    // crash leaves on the disk, what a retention window is holding, and what a
    // transcription unit weighs against the endpoint's body limit. The shared
    // constant is what keeps the browser from answering differently (D1b).
    this.createRecorder = options.createRecorder ?? ((stream) => new MediaRecorder(stream, meetingRecorderOptions()));
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
    const attempt = this.attempt;
    let stream: MediaStream;
    try { stream = await this.openStream(); }
    catch { throw new MicrophoneUnavailableError(); }
    // The prompt was answered after the caller went away. Nothing has been
    // claimed yet, so releasing the tracks is the whole of it — and it is the
    // difference between a recording light that goes out and one that does not.
    if (attempt !== this.attempt) { stopTracks(stream); throw new CaptureCancelledError(); }

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

    // …and asked again after the SECOND await, which is the one that leaves
    // something behind: the capture exists, its directory exists, and main has
    // registered this window as its writer. Abandoning it silently is what made
    // the capture unreachable from every window at once.
    if (attempt !== this.attempt) {
      stopTracks(stream);
      await this.abandon(sessionId);
      throw new CaptureCancelledError();
    }

    this.stream = stream;
    this.recorder = recorder;
    this.sessionId = sessionId;
    this.lastChunkAt = this.now();
    this.pausedAt = null;
    this.writes = Promise.resolve();
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size) this.enqueue(sessionId, event.data);
    };
    /**
     * Guarded, because this is the one statement that runs AFTER the fields are
     * set. `MediaRecorder.start` throws `NotSupportedError` when the stream went
     * inactive between `getUserMedia` and here — an unplugged interface, a
     * device the OS took back. An escape from this line left the microphone open
     * with the tracks live and this object holding a session id, while the
     * caller never received one: nothing could stop it, and nothing could start
     * anything else either, because the next `start` is refused by the id it
     * kept. So the tracks are released and the fields are put back, exactly as
     * the two failures above do it, and the capture is handed back for the same
     * reason the cancellation above hands it back: it is CLAIMED from the moment
     * `begin` returned, and a claim nothing releases outlives the failure by the
     * whole life of the process.
     */
    try { recorder.start(this.chunkMs); }
    catch {
      this.recorder = null;
      this.sessionId = null;
      this.release();
      await this.abandon(sessionId);
      throw new MicrophoneUnavailableError();
    }
    return sessionId;
  }

  pause(): void {
    if (this.recorder?.state !== "recording") return;
    const at = this.now();
    // Set before invoking the platform: a recorder is allowed to deliver a
    // queued blob as pausing takes effect, and that event must see the active
    // clock stop here rather than crediting any later wall time as audio.
    this.pausedAt = at;
    try { this.recorder.pause(); }
    catch (caught) { this.pausedAt = null; throw caught; }
  }

  resume(): void {
    if (this.recorder?.state !== "paused") return;
    const at = this.now();
    // Keep `pausedAt` authoritative until the platform accepts the resume. If
    // `resume()` throws (device loss is one real cause), clearing it first makes
    // the remainder of the pause look like recorded audio on the next attempt.
    this.recorder.resume();
    this.finishPause(at);
  }

  /**
   * Stops the recorder, waits for the final chunk to be written, and only then
   * marks the capture stopped. Returning before the queue drains would let the
   * caller read audio that is missing its last saved chunk.
   *
   * It is also the CANCEL for a `start` that has not returned yet, which is the
   * same statement one step earlier: a caller asking for this recording to end
   * before the microphone answered is asking for it not to begin. There is
   * nothing here to wait for in that case — the fields are still empty — so this
   * returns `null` at once and the abandoned `start` cleans up after itself.
   */
  async stop(): Promise<string | null> {
    this.attempt += 1;
    const recorder = this.recorder;
    const sessionId = this.sessionId;
    this.recorder = null;
    this.sessionId = null;
    if (!recorder || !sessionId) {
      this.release();
      return null;
    }
    // `stop()` flushes a final data event even while paused. Move the active
    // baseline first so that event describes recorded audio, not the hour the
    // microphone was deliberately suspended.
    if (recorder.state === "paused") this.finishPause(this.now());
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

  /** Resolves once every queued chunk has been written (or failed). */
  async settled(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  private enqueue(sessionId: string, blob: Blob): void {
    const wallAt = this.now();
    // Active elapsed time, not the nominal timeslice. While paused the active
    // clock is frozen at `pausedAt`, including for a blob event the platform
    // delivers during the pause; otherwise an hour-long pause becomes an hour
    // of claimed audio and can seal an empty transcription unit.
    const at = this.pausedAt ?? wallAt;
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
    this.pausedAt = null;
  }

  /** Shift the elapsed-time baseline past a pause without inventing captured audio. */
  private finishPause(at: number): void {
    if (this.pausedAt === null) return;
    this.lastChunkAt += Math.max(0, at - this.pausedAt);
    this.pausedAt = null;
  }

  /**
   * A capture that was created and will never be recorded into: hand it back.
   *
   * `discard` rather than `stop`, because there is provably nothing to keep —
   * both callers are on the far side of `begin` and short of
   * `recorder.start(...)`, so `ondataavailable` has never fired and the
   * directory holds a record with no audio under it. What actually has to happen
   * is the CLAIM going away: main registers this window as the capture's writer
   * the moment `begin` returns, and a claim nothing releases hides that capture
   * from every window's offer and refuses it to every other window for the whole
   * life of the process.
   *
   * A failure here is swallowed on purpose. Both callers are already throwing,
   * one of them into a component that is unmounting, so there is no surface left
   * to say it on; and the durable half is covered anyway, because the next
   * launch's boot pass reaps a record with no audio under it.
   */
  private async abandon(sessionId: string): Promise<void> {
    try { await this.capture.discard(sessionId); } catch { /* nothing left to tell */ }
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}
