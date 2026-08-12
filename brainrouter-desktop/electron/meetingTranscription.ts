/**
 * ADR-035 D3/D4/D5/D7/D9/D10 — the desktop's transcription supervisor: the thing
 * that turns durability chunks on disk into transcription units and text, in the
 * process that outlives the window.
 *
 * Open question 3 asks who owns retry, renderer or host, and the ADR answers it
 * in the question: "a renderer-owned queue dies with the window, which is the
 * defect this ADR exists to fix". So the queue lives HERE, in Electron main. A
 * window reload, a renderer crash, or a user navigating away from Meetings does
 * not interrupt transcription — the chunks are already on disk and the drain
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
 * - **The live connection, where the endpoint offers one (D10).** It belongs
 *   here for the same reason the queue does — a renderer-owned socket dies with
 *   the window — and it belongs BESIDE the queue rather than instead of it. The
 *   stream covers what it covers; every chunk it has not covered is still sealed
 *   at the ceiling and drained by the segmented path, which is why a dropped
 *   connection costs a reconnect and never a meeting. `meetingStreamSession.ts`
 *   owns the rules; this file owns only the wiring and the order of the two.
 * - **Closing.** A capture whose audio D6 has released must have no queue still
 *   writing to it, so the entry is marked closed BEFORE the delete and its ports
 *   become inert rather than racing the `rm`.
 * - **Who is recording, which is a question this process can answer EXACTLY.**
 *   See `#writers` below. It replaced a lease — a heartbeat stamped into the
 *   record plus a staleness threshold — and the reason is not that the lease was
 *   badly built: it is that a timing heuristic was standing in for a fact main
 *   already had. Two `BrowserWindow`s share ONE Electron process and one
 *   supervisor, so "is somebody recording into this capture" is a map lookup
 *   here, with no clock, no threshold and no window in which a dead writer still
 *   looks alive. The lease's cost was measured rather than argued: a window
 *   RELOAD left main re-arming a heartbeat for a renderer that no longer
 *   existed, so Transcribe, Create and Delete were all refused for ever over a
 *   recording nobody was making.
 *
 * It does not import `electron`: the channels live in
 * `meetingCaptureChannels.ts` and the broadcast in `meetingCaptureBridge.ts`, so
 * the supervisor can be unit-tested against a temporary directory and a fake
 * transcriber.
 */
import {
  appendChunk,
  createMeetingTranscriptionQueue,
  createSegmentAudioReader,
  drainWakeDelayMs,
  isTerminalCaptureStatus,
  nextChunkSequence,
  sameCaptureScope,
  sealDueUnits,
  stopCapture,
  unitChunkSequences,
  unitPolicyFor,
  MeetingEndpointUnavailableError,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
  type MeetingDrainResult,
  type MeetingLiveUtterance,
  type MeetingTranscriptionQueue,
} from '@kinqs/brainrouter-core/meetings';
import type { BeginCaptureInput, MeetingCaptureStore } from './meetingCapture.js';
import {
  MeetingStreamSession,
  type MeetingTranscriptionStatus,
  type MeetingTranscriptionStreamPort,
} from './meetingStreamSession.js';

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
   * endpoint" from "working". Absent on the per-unit pushes, which happen
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
   * D10 — which transcription strategy this capture is actually on, and the one
   * sentence explaining it.
   *
   * Present only on the pushes that change it, so a surface keeps the last
   * answer rather than blinking between "streaming" and "we did not say" on
   * every persisted segment. Golden rule 23 is the whole reason it is on the
   * wire at all: a host that degraded to segmented upload without saying so is
   * indistinguishable from one that is working.
   */
  readonly transcription?: MeetingTranscriptionStatus;
  /**
   * D4/D10 — provisional live utterances, and the ONE thing here that is not
   * persisted.
   *
   * The rest of this payload is a record already on disk. These are words the
   * endpoint is still revising, published so text can appear WHILE a sentence is
   * being spoken; they are never folded into the compose box, because a person
   * cannot be asked to edit text that is still being rewritten under them (D4).
   * A committed one arrives again — settled, and on disk — as a `done` segment.
   */
  readonly live?: readonly MeetingLiveUtterance[];
}

/**
 * D6 — what a surface says instead of offering a live recording back.
 *
 * One sentence, in one place, because it is said twice: a second window's
 * Meetings screen prints it where the offer would have been, and the destructive
 * channels THROW it. Two spellings of it would be two answers to the same
 * question.
 *
 * It never has to name WHICH window, because it is only ever shown to a window
 * that is not the writer — the rows below carry the holder id, and a surface
 * drops its own before it renders anything.
 *
 * **And it belongs to this host, which is a decision rather than an oversight.**
 * A byte-for-byte twin of it lived in `@kinqs/brainrouter-core/meetings` for a
 * round, beside the lease, and that looked like the duplication D1b exists to
 * refuse. It is not: the sentence names a WINDOW, and a window is the desktop's
 * unit of a writer. The browser's own answer at the same moment says "another
 * tab", because that is what a browsing context is there. One shared string
 * would make one of the two hosts describe a topology it does not have — a
 * worse failure than saying it twice, because it would be wrong on screen
 * rather than merely repeated in a file. What IS shared is the rule either host
 * applies: `resumableSessions`, and the live captures each subtracts from it.
 *
 * The NAME a writer goes by is not shared either, and used to be listed here as
 * though it were. The browser identifies its writer by HOLDING a Web Lock, which
 * the browser itself releases when the browsing context dies; it has no id
 * anywhere, and its holder-id module is deleted with a contract test asserting
 * the deletion. `newCaptureHolderId` therefore has exactly one caller, in this
 * host, and calling it shared is the kind of claim that keeps a module alive for
 * a contract nobody is party to.
 */
export const MEETING_CAPTURE_WRITER_NOTE = 'Another window is recording this meeting right now.';

/**
 * D6 — a capture this process is being recorded into at this instant.
 *
 * Not a lease and not a claim: there is no term, no heartbeat and no expiry,
 * because there is nothing here to expire. An entry exists exactly while a
 * window in THIS process is feeding this capture, and it is removed by the four
 * events that end that — Stop, close, the window going away, and a refused write
 * of the capture itself.
 */
export interface MeetingCaptureWriter {
  readonly sessionId: string;
  /** The window recording it. A surface compares this against its own id. */
  readonly holderId: string;
  /** What that surface then says, if the id is not its own. */
  readonly note: string;
}

export interface MeetingTranscriptionSupervisorOptions {
  readonly transcribe: MeetingSegmentTranscriber;
  /**
   * D10 — the live transcription seam, absent when this build has no way to
   * reach one.
   *
   * Absent means exactly today's behaviour: no capability request is made, every
   * capture is segmented, and nothing on the append path changes. The port is
   * injected for the same reason `transcribe` is — so this module never learns
   * about account bearers, and so a test can drive an endpoint that offers
   * streaming, refuses it, or drops halfway through.
   */
  readonly streaming?: MeetingTranscriptionStreamPort;
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
  /**
   * D10 — this capture's live connection, or null when no streaming port was
   * injected. It stays inert until `begin` starts it: picking a recording up
   * again is not a reason to open a stream, because nobody is producing audio
   * for it.
   */
  stream: MeetingStreamSession | null = null;
  closed = false;
  cancelWake: (() => void) | null = null;
  appends: Promise<unknown> = Promise.resolve();
  drains: Promise<unknown> = Promise.resolve();
}

/** D6 — Record, and the window doing it, so this process can say so exactly. */
export interface BeginRecordingInput extends BeginCaptureInput {
  /**
   * The window that is about to record into this capture.
   *
   * Minted in the renderer, one per BrowserWindow (`captureHolder.ts`), and it
   * has to be the renderer's rather than a host-minted one for a single reason:
   * the surface asks "is the window recording this me?", and an id it could not
   * name would make that question unanswerable. It is a coordination token and
   * not a credential — every window here is our own code and the capture
   * directory is `0700`.
   *
   * Absent when the caller will not say, which registers no writer at all: an
   * anonymous Record is one no other window can be told about, which is worse
   * than the alternative only if you think a missing id should confer immunity.
   */
  readonly writerId?: string;
}

export class MeetingTranscriptionSupervisor {
  readonly #store: MeetingCaptureStore;
  readonly #transcribe: MeetingSegmentTranscriber;
  readonly #streaming: MeetingTranscriptionStreamPort | undefined;
  readonly #publish: (progress: MeetingCaptureProgress) => void;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #now: (() => number) | undefined;
  readonly #entries = new Map<string, Promise<CaptureEntry>>();
  /**
   * D6 — capture id → the window recording into it. The whole mechanism.
   *
   * This map is authoritative rather than advisory, which is the entire point of
   * moving the question here: one Electron process holds every BrowserWindow, so
   * a second window asking "is anything recording this?" is the SAME object
   * answering that the recording window's own Record put the entry into. There
   * is no threshold to tune, and a writer cannot be dead-but-fresh, because
   * nothing here is inferred from a clock.
   *
   * It is not a `Set` beside the store, which is what the previous rounds
   * (rightly) refused: that was per-WINDOW state — `hold.sessionId`,
   * `captureRef.current` — and a second window's copy was empty. This is per
   * PROCESS, which is the unit the desktop's store is registered in.
   *
   * The four removals are the four ways a window stops recording: `stop`, the
   * capture being closed, the window going away (`releaseWindow`, driven by the
   * host from `pagehide`/destroyed), and a `begin` that failed. A renderer
   * RELOAD is the third of those, and it is why a lease could not do this job:
   * main is untouched by a reload, so a heartbeat it owns never goes stale.
   */
  readonly #writers = new Map<string, string>();

  constructor(store: MeetingCaptureStore, options: MeetingTranscriptionSupervisorOptions) {
    this.#store = store;
    this.#transcribe = options.transcribe;
    this.#streaming = options.streaming;
    this.#publish = options.publish ?? (() => undefined);
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now;
  }

  /** D2 — Record creates the meeting, its directory, the queue that will drain it, and the record of who is recording. */
  async begin(input: BeginRecordingInput): Promise<MeetingCaptureSession> {
    const session = await this.#store.begin(input);
    // Registered before the queue is materialized, so there is no instant at
    // which a capture exists and this process cannot say who is recording it.
    if (input.writerId) this.#writers.set(session.id, input.writerId);
    try {
      // Materialized now rather than on the first chunk so the queue is never
      // constructed from a record another writer is already appending to.
      const entry = await this.#entry(session.id);
      // D10 — ask the endpoint what it offers at RECORD, not at the first chunk.
      // The answer has to be in hand before a unit could seal, and nothing on
      // the append path may ever wait for it: a probe that hung would otherwise
      // hold up a durable write, which is the one thing D1 does not allow.
      void entry.stream?.start();
    } catch (caught) {
      // A capture whose queue could not be opened is one nothing will ever
      // record into, and leaving it claimed would bury it from every window for
      // as long as this process lived.
      this.#writers.delete(session.id);
      throw caught;
    }
    return session;
  }

  /**
   * D1/D9 — a durability chunk lands: bytes first, ledger second, units last.
   *
   * The disk sequence comes from the chunk ledger, never from the number of
   * transcription units. Those counters deliberately diverge once several
   * three-second writes make one unit; using `segments.length` here would try
   * to overwrite chunk 1 after the first unit sealed and lose the rest of the
   * recording to `O_EXCL` failures.
   */
  async append(id: string, bytes: Uint8Array, durationMs: number): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    const next = entry.appends.then(async () => {
      const sequence = nextChunkSequence(entry.queue.session);
      const written = await this.#store.writeSegment(id, sequence, bytes);
      const session = await entry.queue.apply((current) => {
        if (nextChunkSequence(current) !== sequence) {
          throw new Error('The meeting chunk ledger changed while audio was being written.');
        }
        // D9/D10 — how big a unit is belongs to the STRATEGY, and the strategy
        // belongs to the endpoint. A streaming endpoint seals at its own spoken
        // boundary, so the policy here becomes ceilings-only and this seal
        // catches nothing until the endpoint has been silent for a long time.
        // Until the capability answer arrives it is the segmented policy, which
        // is what keeps a segmented deployment behaving exactly as it does now.
        return sealDueUnits(
          appendChunk(current, { byteLength: written, durationMs }),
          unitPolicyFor(entry.stream?.mode ?? 'segmented'),
        );
      });
      // D1/D10 — offered only once the bytes and the ledger entry are BOTH on
      // disk. The stream reads them back from there, so a dropped connection
      // replays from the disk rather than from anything held in memory.
      entry.stream?.offer(sequence);
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
   * D6 — and nobody is recording into it from this moment, so any window may
   * offer it back, transcribe it or delete it. The removal happens once the last
   * chunk has settled and BEFORE the commit that marks the capture stopped: a
   * `persist` that failed does not mean the microphone is still open, and
   * leaving the capture claimed over a failed write is how a stopped recording
   * becomes untouchable.
   */
  async stop(id: string): Promise<MeetingCaptureSession> {
    const entry = await this.#entry(id);
    await entry.appends.catch(() => undefined);
    this.#writers.delete(id);
    // D10 — the last utterance is sealed by the endpoint, not by us, so the
    // stream is told the audio has ended BEFORE the remainder is sealed for the
    // batch path. Bounded inside the stream: what it never covers is sealed
    // below and transcribed segment-wise, which is the mandatory fallback.
    await entry.stream?.finish().catch(() => undefined);
    const session = await entry.queue.apply((current) => stopCapture(current));
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
  async adopt(id: string, holderId?: string): Promise<MeetingCaptureSession> {
    // D6 — refused outright while another window is recording into it, and
    // BEFORE the entry is opened: refusing is the whole point of doing this here
    // rather than after the compose form has already filled itself in from a
    // meeting somebody else is making.
    //
    // A pick-up registers no writer of its own, because a pick-up is not a
    // recording — nobody is producing audio for this capture, so nothing should
    // claim otherwise. What it buys is the refusal.
    this.#refuseForeignWriter(id, holderId);
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
  async close(id: string, outcome: 'finalize' | 'discard', by?: string): Promise<void> {
    // FIRST, and before anything is touched. The previous shape refused inside
    // the store, after this method had already dropped the entry, marked it
    // closed and stopped its timers — and the supervisor is per PROCESS, so
    // those were the RECORDING window's. Measured: a second window's refused
    // Delete froze the live capture's heartbeat, and thirty-one seconds later
    // the same button deleted the meeting while the microphone was open. A
    // refused destructive action must leave the live capture exactly as it was,
    // which is only true if the refusal happens before the first mutation.
    this.#refuseForeignWriter(id, by);
    const pending = this.#entries.get(id);
    this.#entries.delete(id);
    this.#writers.delete(id);
    const entry = pending ? await pending.catch(() => null) : null;
    if (entry) {
      entry.closed = true;
      // D10 — before the audio is released, and for the same reason the ports go
      // inert: a live connection still sending chunks out of a directory that is
      // about to stop existing would be a write racing the `rm`.
      entry.stream?.close();
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
   * D6 — the captures this process is being recorded into, scoped to one
   * workspace, for a surface to say what it must not offer back.
   *
   * The record is read only to answer the SCOPE question (open question 5 — a
   * meeting recorded under one org is never re-attached under another). Liveness
   * itself never touches the disk: it is the map, which is the correction this
   * round is. A capture whose record has gone is dropped rather than reported,
   * because there is nothing left for a surface to say anything about.
   */
  async writing(scope?: MeetingCaptureScope): Promise<MeetingCaptureWriter[]> {
    const rows: MeetingCaptureWriter[] = [];
    for (const [sessionId, holderId] of this.#writers) {
      if (scope) {
        try {
          const { session } = await this.#store.stored(sessionId);
          if (!sameCaptureScope(session.scope, scope)) continue;
        } catch { continue; }
      }
      rows.push({ sessionId, holderId, note: MEETING_CAPTURE_WRITER_NOTE });
    }
    return rows;
  }

  /** D6 — is anybody in this process recording into that capture? The whole predicate. */
  isWriting(id: string): boolean {
    return this.#writers.has(id);
  }

  /**
   * D6 — that window is gone: reloaded, closed, or its renderer died.
   *
   * The event a lease could only APPROXIMATE, and got wrong in the direction
   * that matters: main is untouched by a renderer reload, so a heartbeat main
   * owns never lapses and the recording stays claimed by a page that no longer
   * exists. Here it is a fact the host observes and reports, and the captures
   * that window was recording become ordinary unfinished recordings — offered
   * back, playable, and deletable — at that instant.
   *
   * Returns what it released, so the host can tell every window to look again.
   */
  releaseWindow(holderId: string): string[] {
    const released: string[] = [];
    for (const [sessionId, writer] of this.#writers) {
      if (writer === holderId) released.push(sessionId);
    }
    for (const sessionId of released) this.#writers.delete(sessionId);
    return released;
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
   * The writers are dropped with them, because this process is the only thing
   * that ever knew about them: nothing survives to be corrected, and the record
   * on disk says `recording`, which the next launch's boot pass reads as the
   * interrupted recording it is.
   */
  dispose(): void {
    for (const pending of this.#entries.values()) {
      void pending.then((entry) => {
        // The socket goes with the timers: the audio and the record are already
        // on disk, so quitting mid-stream costs the uncovered tail a segmented
        // transcription and nothing else.
        entry.stream?.close();
        entry.cancelWake?.();
        entry.cancelWake = null;
      }, () => undefined);
    }
    this.#entries.clear();
    this.#writers.clear();
  }

  /**
   * D6 — the one guard, asked by everything that would take a recording away
   * from the window making it.
   *
   * Silent when the asker IS the writer: a window has to be able to finish the
   * meeting it is recording, and a guard that only asked "is anybody writing?"
   * would wedge the single window entitled to press Create.
   */
  #refuseForeignWriter(id: string, holderId?: string): void {
    const writer = this.#writers.get(id);
    if (writer !== undefined && writer !== holderId) throw new Error(MEETING_CAPTURE_WRITER_NOTE);
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
          readChunk: async (sequence) => {
            if (entry.closed) throw new Error('This meeting capture is closing.');
            return await this.#store.readSegment(id, sequence);
          },
        }, {
          // D9 — a unit is not a file. The record is the authority for exactly
          // which durability chunks it spans; reading only `segment.index`
          // produces plausible text for a fraction of the meeting with no gap.
          chunksOf: (index) => {
            const unit = entry.queue.session.segments[index];
            if (!unit) throw new Error(`Meeting ${id} has no transcription unit ${index}.`);
            return unitChunkSequences(unit);
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
    if (this.#streaming) {
      entry.stream = new MeetingStreamSession({
        sessionId: id,
        mimeType: contentType,
        ...(language ? { language } : {}),
        port: this.#streaming,
        ledger: {
          // Everything the live path touches goes through the SINGLE WRITER the
          // queue already is. A stream that edited the record beside it would be
          // the second writer this subsystem spent a round removing.
          session: () => entry.queue.session,
          apply: async (transition) => await entry.queue.apply(transition),
          readChunk: async (sequence) => (entry.closed ? null : await this.#store.readSegment(id, sequence)),
        },
        publish: (publication) => {
          if (entry.closed) return;
          this.#publish({
            sessionId: id,
            // Already on disk: the live utterances ride beside the last
            // persisted record rather than opening a second channel of their
            // own, so a surface has one place to read a capture's state from.
            session: entry.queue.session,
            transcription: publication.status,
            live: publication.live,
          });
        },
        schedule: this.#schedule,
      });
    }
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
