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
 * - **The capture lease's heartbeat.** The RULES are `captureLease.ts`'s and not
 *   restated here; what is host work is that somebody has to say "still here" on
 *   a cadence, and it has to be the process that owns the record — a renderer
 *   heartbeat dies with the window, which is the same argument that put the
 *   queue here. It rides every durable write as well as the timer, because the
 *   timer is the half that a stalled main thread drops, and it is held only
 *   while a recorder is actually feeding the capture: a lease that outlived the
 *   recording would bury the meeting from every other window for as long as this
 *   process stayed up.
 *
 * It does not import `electron`: the IPC surface and the broadcast live in
 * `meetingCaptureBridge.ts`, so the supervisor can be unit-tested against a
 * temporary directory and a fake transcriber.
 */
import {
  acquireCaptureLease,
  appendSegment,
  createMeetingTranscriptionQueue,
  createSegmentAudioReader,
  drainWakeDelayMs,
  heartbeatCaptureLease,
  isTerminalCaptureStatus,
  releaseCaptureLease,
  stopCapture,
  MEETING_CAPTURE_HEARTBEAT_MS,
  MeetingEndpointUnavailableError,
  type CaptureCloseActor,
  type MeetingCaptureLeaseClaim,
  type MeetingCaptureLeaseRequest,
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
  /**
   * D6 — this process was writing to that capture and is not any more, in the
   * words to show the person who was recording.
   *
   * Separate from `errors` because it is a different fact and needs a different
   * response: `errors` means "the record is stale on disk, the audio is still
   * here", and the window should keep recording. This means another holder took
   * the recording over — the fencing epoch moved — and the right move is to stop
   * the microphone in this window rather than keep producing chunks nothing will
   * ever claim. A surface that rendered it as the other message would tell the
   * user to wait for a write that is never coming.
   */
  readonly writerLost?: string;
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
  /**
   * D6 — what this process believes it holds on this capture's lease, and the
   * timer that keeps saying so.
   *
   * `claim` is null whenever nobody is recording into this capture from here:
   * before Record, after Stop, and the moment a heartbeat comes back refused.
   * `holder` outlives the claim because a lapsed lease is RE-ACQUIRED rather
   * than renewed (the lease module's invariant 4), and re-acquiring needs the
   * same identity the surface is describing.
   */
  claim: MeetingCaptureLeaseClaim | null = null;
  holder: MeetingCaptureLeaseRequest | null = null;
  cancelBeat: (() => void) | null = null;
  /**
   * "This process just lost the recording", waiting to be published.
   *
   * Held here rather than published from inside the transition because a
   * transition runs INSIDE the queue's write chain: publishing there would send
   * the surface the session as it was before the commit, which is the one thing
   * the progress channel promises never to do (D4 — what is pushed is already on
   * disk). It is flushed by the caller, after the commit resolves.
   */
  notice: string | null = null;
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

  /** D2 — Record creates the meeting, its directory, the lease it is recorded under, and the queue that will drain it. */
  async begin(input: BeginCaptureInput): Promise<MeetingCaptureSession> {
    const session = await this.#store.begin(input);
    // Materialized now rather than on the first chunk so the queue is never
    // constructed from a record another writer is already appending to.
    const entry = await this.#entry(session.id);
    // `begin` put the lease in the record; this is where the PROCESS starts
    // saying it is still there. Without the heartbeat the stamp on disk is one
    // instant old and stale thirty seconds later, so the whole mechanism would
    // be inert exactly when a meeting runs longer than half a minute.
    if (input.holder) this.#take(entry, input.holder, session);
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
      // D6 — the heartbeat rides the DURABLE WRITE, not only the timer, and the
      // two are folded into one commit so a chunk can never be recorded without
      // its writer also saying it is still here. The timer is the one that is
      // easy to lose: a throttled or stalled main thread misses beats, while
      // `ondataavailable` comes from the media stack, which is why the staleness
      // window is a multiple of the chunk cadence rather than of the timer.
      const session = await entry.queue.apply((current) =>
        appendSegment(this.#renew(entry, current), { byteLength: written, durationMs }));
      this.#flushNotice(id, entry);
      this.#kick(id, entry);
      return session;
    });
    // The stored tail swallows rejections so one failed chunk cannot poison
    // every later one; the caller still sees its own error.
    entry.appends = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Capture ended cleanly. The audio stays and the queue keeps draining it (D7).
   *
   * D6 — and the lease is handed back in the same commit the capture is marked
   * stopped, so the meeting is offerable to any other window AT ONCE rather than
   * thirty seconds later. This is an optimisation and nothing here depends on
   * it: §6 kills the process, which never reaches this line, and expiry is what
   * covers that.
   */
  async stop(id: string): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    await entry.appends.catch(() => undefined);
    this.#stopBeat(entry);
    const session = await entry.queue.apply((current) => this.#release(entry, stopCapture(current)));
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
  async adopt(id: string, holder?: MeetingCaptureLeaseRequest): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    // D6 — a pick-up TAKES the recording, and is refused outright while another
    // window's lease is fresh. The acquisition is what fences the previous
    // holder: it issues a new epoch, so a window that was stalled long enough to
    // lose the lease cannot heartbeat its way back over this one. Refusing is
    // the whole point of doing it here rather than after the compose form has
    // already filled itself in from a meeting somebody else is recording.
    if (holder) {
      let taken: MeetingCaptureLeaseClaim | null = null;
      await entry.queue.apply((current) => {
        const outcome = acquireCaptureLease(current, holder);
        if (!outcome.ok) throw new Error(outcome.detail);
        taken = { holderId: outcome.lease.holderId, epoch: outcome.lease.epoch };
        return outcome.session;
      });
      entry.holder = holder;
      entry.claim = taken;
      // No heartbeat: a pick-up is not a recording. The lease lapses on its own
      // in one staleness window, which is exactly right — nobody is producing
      // audio for this capture, so nothing should keep claiming otherwise. What
      // the acquisition buys is the refusal above and the fence.
    }
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
  async close(id: string, outcome: 'finalize' | 'discard', by?: CaptureCloseActor): Promise<void> {
    const pending = this.#entries.get(id);
    this.#entries.delete(id);
    const entry = pending ? await pending.catch(() => null) : null;
    if (entry) {
      entry.closed = true;
      entry.cancelWake?.();
      entry.cancelWake = null;
      this.#stopBeat(entry);
      // Let what is already running finish against the now-inert ports, so the
      // delete below is not racing a write it cannot see.
      await entry.appends.catch(() => undefined);
      await entry.drains.catch(() => undefined);
    }
    // `by` reaches the shared transition, which THROWS while another holder is
    // recording. The entry has already been dropped from the map at that point,
    // which is correct: the refusal means this window has no business driving
    // that capture, and the window that is recording it owns its own entry.
    if (outcome === 'finalize') await this.#store.finalize(id, by);
    else await this.#store.discard(id, by);
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

  /**
   * Stop every timer. Called when the app is quitting; the audio is already on disk.
   *
   * The lease is deliberately NOT released here. Quitting is not the same event
   * as stopping a recording, and a release on the way out would say "nobody is
   * writing" about a capture whose window may still be up in another process. A
   * lease nobody renews lapses by itself in one staleness window, which is the
   * only mechanism §6's kill leaves standing anyway.
   */
  dispose(): void {
    for (const pending of this.#entries.values()) {
      void pending.then((entry) => {
        entry.cancelWake?.();
        entry.cancelWake = null;
        this.#stopBeat(entry);
      }, () => undefined);
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

  /** Record what `begin` already wrote, and start saying it is still true. */
  #take(entry: CaptureEntry, holder: MeetingCaptureLeaseRequest, session: MeetingCaptureSession): void {
    entry.holder = holder;
    entry.claim = session.writer ? { holderId: session.writer.holderId, epoch: session.writer.epoch } : null;
    this.#beat(session.id, entry);
  }

  /**
   * The heartbeat as a TRANSITION, so it composes with whatever else is being
   * committed and never needs a write of its own.
   *
   * The three refusals are three different situations and only one of them is a
   * loss:
   *
   * - `lease_expired` / `not_held` — nobody else has taken it; the term simply
   *   ran out (a stall longer than the window, or a record written by a build
   *   that had no lease in it). Re-acquire, which is what the lease module
   *   insists on: a renewal that revived an expired term is migration 048's
   *   unfenced heartbeat, and it would let a writer that was gone for a minute
   *   hold a recording another window has since taken.
   * - `held_by_another` / `stale_epoch` — somebody else IS recording this. The
   *   claim is dropped and the window is told, because continuing to produce
   *   chunks for a capture we no longer own is work nobody will ever read.
   * - `capture_closed` — the meeting was finalized or discarded underneath us.
   *   Nothing to say: the surface that closed it already knows.
   *
   * The session is returned UNCHANGED on every refusal. Refusing to record the
   * audio would be the loss this ADR exists to prevent, arriving through the
   * door meant to stop it — the lease coordinates a recording, it does not
   * license one.
   */
  #renew(entry: CaptureEntry, session: MeetingCaptureSession): MeetingCaptureSession {
    const claim = entry.claim;
    const holder = entry.holder;
    if (!claim || !holder) return session;
    const beat = heartbeatCaptureLease(session, claim);
    if (beat.ok) {
      entry.claim = { holderId: beat.lease.holderId, epoch: beat.lease.epoch };
      return beat.session;
    }
    if (beat.reason === 'lease_expired' || beat.reason === 'not_held') {
      const taken = acquireCaptureLease(session, holder);
      if (taken.ok) {
        entry.claim = { holderId: taken.lease.holderId, epoch: taken.lease.epoch };
        return taken.session;
      }
      entry.notice = taken.detail;
      this.#drop(entry);
      return session;
    }
    if (beat.reason !== 'capture_closed') entry.notice = beat.detail;
    this.#drop(entry);
    return session;
  }

  /** Hand the recording back in the same commit that stops it. Silent when there is nothing held. */
  #release(entry: CaptureEntry, session: MeetingCaptureSession): MeetingCaptureSession {
    const claim = entry.claim;
    if (!claim) return session;
    entry.claim = null;
    const released = releaseCaptureLease(session, claim);
    // A refusal here means the lease is already somebody else's or the capture
    // is closed — in both cases there is nothing of ours left to hand back, and
    // overwriting the record with our idea of the lease would undo a real one.
    return released.ok ? released.session : session;
  }

  #drop(entry: CaptureEntry): void {
    entry.claim = null;
    this.#stopBeat(entry);
  }

  /**
   * The timer half of the heartbeat: five seconds, re-armed after each beat.
   *
   * One-shot-and-re-arm rather than an interval so it uses the same injected
   * scheduler the backoff does — a test can then advance a heartbeat at an exact
   * instant instead of waiting five real seconds for one.
   */
  #beat(id: string, entry: CaptureEntry): void {
    this.#stopBeat(entry);
    if (entry.closed || !entry.claim) return;
    entry.cancelBeat = this.#schedule(() => {
      entry.cancelBeat = null;
      if (entry.closed || !entry.claim) return;
      void entry.queue.apply((current) => this.#renew(entry, current)).then(
        () => { this.#flushNotice(id, entry); this.#beat(id, entry); },
        // A failed beat is a failed WRITE, which the drain path already reports.
        // The claim is untouched, so the next beat tries again — dropping it
        // here would abandon a recording over one unlucky `persist`.
        () => { this.#beat(id, entry); },
      );
    }, MEETING_CAPTURE_HEARTBEAT_MS);
  }

  #stopBeat(entry: CaptureEntry): void {
    entry.cancelBeat?.();
    entry.cancelBeat = null;
  }

  /** D6/ADR-028 — publish "you lost the recording" once, after the commit that discovered it. */
  #flushNotice(id: string, entry: CaptureEntry): void {
    const notice = entry.notice;
    if (!notice || entry.closed) { entry.notice = null; return; }
    entry.notice = null;
    this.#publish({ sessionId: id, session: entry.queue.session, writerLost: notice });
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
