/**
 * ADR-035 D3/D4/D5/D7 — the desktop's transcription supervisor: the thing that
 * turns segments on disk into text, in the process that outlives the window.
 *
 * Open question 3 asks who owns retry, renderer or host, and the ADR answers it
 * in the question: "a renderer-owned queue dies with the window, which is the
 * defect this ADR exists to fix". So the queue lives HERE, in Electron main. A
 * window reload, a renderer crash, or a user navigating away from Meetings does
 * not interrupt transcription — the segments are already on disk and the drain
 * loop is not in the window that went away.
 *
 * This module is a wiring layer and deliberately nothing more. The scheduling,
 * the concurrency bound, the retry rule and the outage rule all come from
 * `@kinqs/brainrouter-core/meetings`'s `MeetingTranscriptionQueue`, which the
 * dashboard uses too (D1b). Writing a second queue here — or a second backoff,
 * or a second "is this an outage" test — is how two hosts start disagreeing
 * about when a meeting has run out of retries.
 *
 * What this file owns, and why each part could not live in the shared queue:
 *
 * - **One queue per capture, created on demand.** The queue is the single writer
 *   of its session, so there must be exactly one, and everything that mutates
 *   the record — an append, a stop, a retry — goes through it rather than beside
 *   it. `MeetingCaptureStore` writes the bytes; this decides what the record
 *   then says.
 * - **The clock.** The queue reports when it is worth draining again; turning
 *   that into a timer is host work, and it is injectable so a test can advance a
 *   backoff without waiting for it. The DELAY itself is not host work: this file
 *   kept `const MIN_WAKE_MS = 250` while the dashboard inlined
 *   `Math.max(500, result.nextWakeMs)` — one scheduling floor, two values, and
 *   nothing anywhere that could notice. Both now ask `drainWakeDelayMs`, which
 *   also folds in the "is there anything to schedule at all" check. Adopting the
 *   shared 500 doubled THIS host's floor, and the floor only binds on the error
 *   path anyway: every real backoff starts at 2 s and passes through untouched.
 * - **The push to the renderer.** D4 wants text as it is produced, so every
 *   persisted transition is published. The persist port is the right place: a
 *   published session is by construction one that is already on disk. A drain
 *   that ends also publishes its PHASE and any write errors it collected —
 *   without those two, a queue waiting on a dead endpoint and a queue that is
 *   working push exactly the same thing, which is the spinner ADR-028 refuses.
 * - **Closing.** A capture whose audio D6 has released must have no queue still
 *   writing to it, so the entry is marked closed BEFORE the delete and its ports
 *   become inert rather than racing the `rm`.
 *
 * It does not import `electron`: the IPC surface and the broadcast live in
 * `meetingCaptureBridge.ts`, so the supervisor can be unit-tested against a
 * temporary directory and a fake transcriber.
 */
import {
  appendSegment,
  createMeetingTranscriptionQueue,
  createSegmentAudioReader,
  drainWakeDelayMs,
  isTerminalCaptureStatus,
  stopCapture,
  MeetingEndpointUnavailableError,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
  type MeetingDrainResult,
  type MeetingTranscriptionQueue,
} from '@kinqs/brainrouter-core/meetings';
import type { BeginCaptureInput, MeetingCaptureStore } from './meetingCapture.js';

/**
 * The one thing the supervisor cannot do itself: reach the STT endpoint. It is
 * injected so this module never learns about account bearers, and so a test can
 * black-hole the endpoint the way §6's second supporting criterion asks.
 */
export interface MeetingSegmentTranscriberInput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly language?: string;
}

export type MeetingSegmentTranscriber = (input: MeetingSegmentTranscriberInput) => Promise<string>;

/**
 * What the renderer is told when a capture's record changes.
 *
 * Persisted, EXCEPT when `errors` is present: that push exists precisely because
 * a write failed, so its session is the queue's in-memory one. The distinction
 * matters to a surface — text arriving with an error beside it is text that may
 * not survive the next crash, and ADR-028 says a surface must be able to tell.
 */
export interface MeetingCaptureProgress {
  readonly sessionId: string;
  readonly session: MeetingCaptureSession;
  /**
   * D4/D7 — why the queue last stopped, so a surface can tell "waiting on a dead
   * endpoint" from "working". Absent on the per-segment pushes, which happen
   * mid-drain when there is no answer to that question yet.
   */
  readonly phase?: MeetingDrainPhase;
  /**
   * Problems that belong to no segment — a `persist` that threw. Reported rather
   * than swallowed: a host whose writes are failing is a host about to lose a
   * meeting, and that is worth saying out loud (ADR-028).
   */
  readonly errors?: readonly string[];
}

export interface MeetingTranscriptionSupervisorOptions {
  readonly transcribe: MeetingSegmentTranscriber;
  readonly publish?: (progress: MeetingCaptureProgress) => void;
  /** Returns a canceller. Injected so a test can drive the backoff at an exact instant. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  /**
   * Epoch milliseconds, handed to the queue as its clock. Injected alongside
   * `schedule` because the two have to agree: a test that fires a timer without
   * moving the clock would find the queue still serving the same backoff.
   */
  readonly now?: () => number;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
}

/**
 * One capture's live state.
 *
 * `appends` and `drains` are separate chains on purpose: an append must never
 * queue behind a network round trip, because D1 says the bytes come first and a
 * chunk that waits for a transcription to finish is a chunk still in memory.
 */
class CaptureEntry {
  /** Assigned by the factory immediately after construction; the ports close over the entry. */
  queue!: MeetingTranscriptionQueue;
  closed = false;
  cancelWake: (() => void) | null = null;
  appends: Promise<unknown> = Promise.resolve();
  drains: Promise<unknown> = Promise.resolve();
}

export class MeetingTranscriptionSupervisor {
  readonly #store: MeetingCaptureStore;
  readonly #transcribe: MeetingSegmentTranscriber;
  readonly #publish: (progress: MeetingCaptureProgress) => void;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #now: (() => number) | undefined;
  readonly #entries = new Map<string, Promise<CaptureEntry>>();

  constructor(store: MeetingCaptureStore, options: MeetingTranscriptionSupervisorOptions) {
    this.#store = store;
    this.#transcribe = options.transcribe;
    this.#publish = options.publish ?? (() => undefined);
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now;
  }

  /** D2 — Record creates the meeting, its directory, and the queue that will drain it. */
  async begin(input: BeginCaptureInput): Promise<MeetingCaptureSession> {
    const session = await this.#store.begin(input);
    // Materialized now rather than on the first chunk so the queue is never
    // constructed from a record another writer is already appending to.
    await this.#entry(session.id);
    return session;
  }

  /**
   * D1/D3 — a chunk lands: bytes first, record second, then transcribe it.
   *
   * The index comes from the queue's own session, and appends for one capture
   * are serialized here, so two chunks can never claim the same segment file.
   */
  async append(id: string, bytes: Uint8Array, durationMs: number): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    const next = entry.appends.then(async () => {
      const index = entry.queue.session.segments.length;
      const written = await this.#store.writeSegment(id, index, bytes);
      const session = await entry.queue.apply((current) => appendSegment(current, { byteLength: written, durationMs }));
      this.#kick(id, entry);
      return session;
    });
    // The stored tail swallows rejections so one failed chunk cannot poison
    // every later one; the caller still sees its own error.
    entry.appends = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Capture ended cleanly. The audio stays and the queue keeps draining it (D7). */
  async stop(id: string): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    await entry.appends.catch(() => undefined);
    const session = await entry.queue.apply(stopCapture);
    this.#kick(id, entry);
    return session;
  }

  /**
   * Start (or resume) transcribing a capture this process is not already
   * driving — the recovery offer's "Transcribe it", and the path a window
   * reload takes back to a recording main never stopped working on.
   *
   * Recovered captures are NOT drained automatically at boot: uploading audio a
   * user has not asked us to do anything with is not a decision a launch should
   * make for them. The offer is the consent, so this is where the queue starts.
   */
  async adopt(id: string): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    this.#kick(id, entry);
    return entry.queue.session;
  }

  /** D5 — a person asked for this gap again. One attempt, bypassing the backoff and the bound. */
  async retry(id: string, index: number): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    const result = await entry.queue.retry(index);
    // Published as well as returned: the caller gets the session, but the PHASE
    // is the answer to "did that help" — a retry into a still-dead endpoint
    // comes back `unavailable`, and a surface that only read the session would
    // show the same gap with no explanation of why it is still there.
    if (!entry.closed) this.#report(id, result);
    const delay = drainWakeDelayMs(result.nextWakeMs);
    if (delay !== null) this.#wake(id, entry, delay);
    return result.session;
  }

  /**
   * D6 — the meeting was accepted or thrown away, so the audio is released.
   *
   * The entry is closed BEFORE the store deletes anything: its ports go inert,
   * so a transcription still in flight cannot rewrite a record for a directory
   * that is about to stop existing, and nothing is published for a capture the
   * user has just finished with.
   */
  async close(id: string, outcome: 'finalize' | 'discard'): Promise<void> {
    const pending = this.#entries.get(id);
    this.#entries.delete(id);
    const entry = pending ? await pending.catch(() => null) : null;
    if (entry) {
      entry.closed = true;
      entry.cancelWake?.();
      entry.cancelWake = null;
      // Let what is already running finish against the now-inert ports, so the
      // delete below is not racing a write it cannot see.
      await entry.appends.catch(() => undefined);
      await entry.drains.catch(() => undefined);
    }
    if (outcome === 'finalize') await this.#store.finalize(id);
    else await this.#store.discard(id);
  }

  /**
   * Resolves once this capture has no append or drain still running.
   *
   * Exported for tests, which need a deterministic point to assert at; it does
   * NOT wait for a scheduled backoff, because waiting out a real backoff is the
   * thing the injected scheduler exists to avoid.
   */
  async settle(id: string): Promise<void> {
    const pending = this.#entries.get(id);
    const entry = pending ? await pending.catch(() => null) : null;
    if (!entry) return;
    // Each pass can start the next one (an append kicks a drain), so this
    // repeats until a pass changes nothing. The bound stops a pathological
    // persist-failure loop from hanging a test forever.
    for (let pass = 0; pass < 16; pass += 1) {
      const { appends, drains } = entry;
      await appends.catch(() => undefined);
      await drains.catch(() => undefined);
      if (entry.appends === appends && entry.drains === drains) return;
    }
  }

  /** Stop every timer. Called when the app is quitting; the audio is already on disk. */
  dispose(): void {
    for (const pending of this.#entries.values()) {
      void pending.then((entry) => { entry.cancelWake?.(); entry.cancelWake = null; }, () => undefined);
    }
    this.#entries.clear();
  }

  #entry(id: string): Promise<CaptureEntry> {
    const existing = this.#entries.get(id);
    if (existing) return existing;
    const created = this.#create(id).catch((caught: unknown) => {
      // A capture that could not be opened must not leave a rejected promise in
      // the map: every later call for that id would fail with a stale error
      // rather than trying again.
      if (this.#entries.get(id) === created) this.#entries.delete(id);
      throw caught;
    });
    this.#entries.set(id, created);
    return created;
  }

  async #create(id: string): Promise<CaptureEntry> {
    const { session, contentType } = await this.#store.stored(id);
    if (isTerminalCaptureStatus(session.status)) {
      throw new Error('That meeting capture has already been finalized or discarded.');
    }
    const entry = new CaptureEntry();
    const language = session.language;
    entry.queue = createMeetingTranscriptionQueue({
      session,
      mimeType: contentType,
      ports: {
        // The shared reader, not the raw file. `MediaRecorder` puts the
        // container header in the FIRST chunk only, so every later chunk is a
        // bare fragment that `ffmpeg -i` refuses — post them untouched and this
        // host transcribes segment 0 and nothing else, which looks exactly like
        // the feature working. Putting the header back is byte framing with no
        // filesystem in it, so it is core's (D1b: only the write target is
        // host-specific) and this file supplies only the chunks.
        readSegment: createSegmentAudioReader({
          readChunk: async (index) => {
            if (entry.closed) throw new Error('This meeting capture is closing.');
            return await this.#store.readSegment(id, index);
          },
        }),
        transcribe: async (audio, mimeType) => {
          // A closing capture is reported as an outage rather than a failure so
          // the segment keeps its attempt: nothing is wrong with the audio, and
          // spending its budget on our own shutdown would be a lie about it.
          if (entry.closed) throw new MeetingEndpointUnavailableError('This meeting capture is closing.');
          return await this.#transcribe({ bytes: audio, contentType: mimeType, ...(language ? { language } : {}) });
        },
        persist: async (next) => {
          if (entry.closed) return;
          await this.#store.persist(next);
          // D4 — published only after the write, so what the surface renders is
          // by construction something that survives the process dying.
          this.#publish({ sessionId: id, session: next });
        },
        // Omitted unless injected, so the queue keeps its own `Date.now()`
        // default rather than being handed a wrapper around it.
        ...(this.#now ? { now: this.#now } : {}),
      },
    });
    return entry;
  }

  #kick(id: string, entry: CaptureEntry): void {
    if (entry.closed) return;
    entry.cancelWake?.();
    entry.cancelWake = null;
    // `drain()` joins a run that is already going and re-plans, so a chunk that
    // landed mid-drain is picked up by the loop already running rather than by a
    // second one competing with it for the same segment.
    const run = entry.queue.drain().then(
      (result) => {
        if (entry.closed) return;
        this.#report(id, result);
        const delay = drainWakeDelayMs(result.nextWakeMs);
        if (delay !== null) this.#wake(id, entry, delay);
      },
      (caught: unknown) => {
        if (entry.closed) return;
        this.#publish({ sessionId: id, session: entry.queue.session, errors: [describe(caught)] });
      },
    );
    entry.drains = entry.drains.then(() => run, () => run);
  }

  /**
   * D4/D7 — tell the renderer where the queue stopped, every time it stops.
   *
   * Published unconditionally rather than only when something failed, because
   * "the endpoint is not answering" is not a failure the segments record: they
   * sit at `pending` with nothing spent (D7), which reads on a surface exactly
   * like a queue that is working. The phase is the only place that difference
   * exists, so a drain that produced no news still has news.
   */
  #report(id: string, result: MeetingDrainResult): void {
    this.#publish({
      sessionId: id,
      session: result.session,
      phase: result.phase,
      ...(result.errors.length ? { errors: result.errors } : {}),
    });
  }

  /** `delayMs` is already `drainWakeDelayMs`'s answer — the floor is the shared rule's, not this file's. */
  #wake(id: string, entry: CaptureEntry, delayMs: number): void {
    if (entry.closed) return;
    entry.cancelWake?.();
    entry.cancelWake = this.#schedule(() => {
      entry.cancelWake = null;
      this.#kick(id, entry);
    }, delayMs);
  }
}

function describe(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : 'The transcription queue failed.';
}
