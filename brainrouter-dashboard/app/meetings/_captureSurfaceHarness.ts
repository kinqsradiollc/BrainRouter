/**
 * The renderer harness for ADR-035's dashboard capture surface.
 *
 * One backend stands for the ORIGIN's storage, one lock table stands for the
 * origin's `navigator.locks`, and each `Tab` stands for a browser tab over both:
 * its own `MeetingCaptureStore`, its own `CaptureLocks`, its own
 * `MeetingCaptureSurface`. That is the shape of the host this ADR keeps being
 * bitten by — OPFS and the lock table are scoped to the origin, not to the tab —
 * so it is the shape the harness has to have, or the defects it exists to catch
 * are unreachable from it by construction.
 *
 * Everything is driven and nothing is stubbed that holds a decision: the store
 * is the REAL `MeetingCaptureStore` over the real fixture backend, the
 * transcription queue is the real shared scheduler, the locks are the real
 * `CaptureLocks` over a lock table that behaves like the browser's, and the
 * session model is the shared one. What is faked is the browser — a recorder
 * whose chunks a test hands over by name, a clock a test moves, timers a test
 * fires — because those are the things a Node runner does not have and the
 * things a defect is never hiding in.
 *
 * `tab.kill()` is what §6 is judged with: the browser drops the locks that tab
 * held and the tab never runs another line. No clock moves, because nothing
 * about the answer depends on one any more.
 *
 * The clock and the timers are still manual, for the two things that really are
 * about elapsed time: the draft's debounce, and D7's outage backoff — the queue
 * reads the same `now` port, so a test can drive a probe schedule that would
 * otherwise cost it a minute of real seconds.
 *
 * The underscore prefix keeps it out of the `*.test.ts` glob.
 */
import { DEFAULT_MEETING_UNIT_MS } from "@kinqs/brainrouter-core/meetings";

import { FakeCaptureBackend, type FakeCaptureBackendOptions } from "../../lib/meetings/_captureBackendFixture";
import { FakeLockManager, FakeLockOrigin } from "../../lib/meetings/_captureLockFixture";
import { CaptureLocks } from "../../lib/meetings/captureLock";
import { MeetingCaptureStore } from "../../lib/meetings/captureStore";
import type { CaptureSessionRecord } from "../../lib/meetings/captureStore";
import { restoreCaptureSession } from "../../lib/meetings/capturePayload";
import type { LegacyDraftStorage } from "../../lib/meetings/meetingDraft";
import {
  MeetingCaptureSurface,
  type CaptureMicrophone,
  type CaptureRecorder,
  type CaptureSurfacePorts,
  type CaptureSurfaceState,
  type CreateMeetingInput,
} from "./captureSurface";

/** A `MediaRecorder` reduced to what the surface uses, plus a way to hand it a chunk. */
export class FakeRecorder implements CaptureRecorder {
  mimeType = "audio/webm";

  state: "inactive" | "recording" | "paused" = "inactive";

  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;

  onstop: (() => void) | null = null;

  starts = 0;

  stops = 0;

  timeslice = 0;

  /**
   * Chunks handed over when `stop()` is called, because that is what a real
   * `MediaRecorder` does: the final `ondataavailable` fires and `onstop` follows
   * it immediately, which is the race `settled()` exists for.
   */
  pending: Blob[] = [];

  /** A recorder that refuses to start — a mic unplugged between `getUserMedia` and here. */
  startFails = false;

  /** One-shot failures used to prove pause timing changes are transactional. */
  pauseFails = false;

  resumeFails = false;

  start(timesliceMs: number): void {
    if (this.startFails) throw new Error("NotSupportedError");
    this.state = "recording";
    this.timeslice = timesliceMs;
    this.starts += 1;
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.stops += 1;
    for (const blob of this.pending.splice(0)) this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }

  pause(): void {
    if (this.pauseFails) {
      this.pauseFails = false;
      throw new Error("InvalidStateError: pause refused");
    }
    this.state = "paused";
  }

  resume(): void {
    if (this.resumeFails) {
      this.resumeFails = false;
      throw new Error("InvalidStateError: resume refused");
    }
    this.state = "recording";
  }

  /** One timeslice's worth of audio, as the media stack would deliver it. */
  emit(blob: Blob): void {
    this.ondataavailable?.({ data: blob });
  }
}

export class FakeMicrophone implements CaptureMicrophone {
  readonly recorder = new FakeRecorder();

  releases = 0;

  release(): void {
    this.releases += 1;
  }
}

interface Timer {
  readonly handle: number;
  readonly run: () => void;
  readonly dueAt: number;
}

/** The origin: one backend, one lock table, one wall clock, many tabs. */
export class CaptureOrigin {
  /**
   * This origin's storage. `writeTicks` and friends are how a test makes a write
   * slower than the settle that has to wait for it — with instant writes every
   * ordering looks correct, which is the shape that hid a meeting being settled
   * without its ending.
   */
  readonly backend: FakeCaptureBackend;

  /**
   * `navigator.locks` for this origin — shared by every tab, as the real one is.
   *
   * It logs into the backend's own call list so the two fakes read as one
   * ordered history of what this origin did.
   */
  readonly locks: FakeLockOrigin;

  /** A fixed instant, so every stamp in a stored record is checkable. */
  clock = Date.parse("2026-08-01T09:00:00.000Z");

  readonly timers: Timer[] = [];

  #nextHandle = 1;

  constructor(storage: FakeCaptureBackendOptions = {}) {
    this.backend = new FakeCaptureBackend(storage);
    this.locks = new FakeLockOrigin(this.backend.calls);
  }

  tab(options: TabOptions = {}): CaptureTab {
    return new CaptureTab(this, options);
  }

  setTimer(run: () => void, ms: number): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.timers.push({ handle, run, dueAt: this.clock + ms });
    return handle;
  }

  clearTimer(handle: number): void {
    const index = this.timers.findIndex((timer) => timer.handle === handle);
    if (index >= 0) this.timers.splice(index, 1);
  }

  /** Move the wall clock WITHOUT firing anything — a tab that is not running. */
  skip(ms: number): void {
    this.clock += ms;
  }

  /** Move the clock and fire every timer that came due, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.dueAt <= until).sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      this.clock = Math.max(this.clock, due.dueAt);
      this.clearTimer(due.handle);
      due.run();
      await flush();
    }
    this.clock = until;
    await flush();
  }

  /** Every stored capture, as a tab's `list()` would see it. */
  async records(): Promise<readonly CaptureSessionRecord[]> {
    return new MeetingCaptureStore(this.backend).list();
  }

  async record(sessionId: string): Promise<CaptureSessionRecord | undefined> {
    return new MeetingCaptureStore(this.backend).read(sessionId);
  }

  /** The stored session as any tab would restore it. */
  async session(sessionId: string, orgId: string | null = null) {
    const record = await this.record(sessionId);
    if (!record) throw new Error(`no stored capture ${sessionId}`);
    return restoreCaptureSession({ record, scope: { orgId }, at: new Date(this.clock).toISOString() });
  }
}

export interface TabOptions {
  readonly orgId?: string;
  readonly legacyDraft?: LegacyDraftStorage;
  /**
   * A tab whose browser has no Web Locks — Safari up to 15.3, Firefox up to 95,
   * the older in-app WebViews. Golden rule 23's case, and the only way to reach
   * the fallback's behaviour.
   *
   * Deliberately NOT "a dashboard served over plain http", which this said and
   * which is wrong twice over. `http://localhost` is a potentially trustworthy
   * origin, so it is a SECURE context with Web Locks, a microphone and no reason
   * to be here at all — and it is the URL this dashboard is developed on. An
   * origin that really is insecure has no `navigator.mediaDevices` either, so
   * nothing can be recorded there and no two tabs can race over a recording. The
   * browsers above are secure contexts that record perfectly well and cannot
   * coordinate, which is what makes the fallback worth having.
   */
  readonly withoutLocks?: boolean;
  /**
   * A browser that said no to `navigator.storage.persist()` — D11's case, which
   * is granted on engagement heuristics rather than on asking.
   *
   * It changes what a test can see as well as what the product promises: an
   * already-persisted store is reused, so nothing asks the browser for anything
   * again, and "did this page raise a storage prompt?" becomes unanswerable.
   */
  readonly persistenceRefused?: boolean;
}

export class CaptureTab {
  readonly origin: CaptureOrigin;

  readonly store: MeetingCaptureStore;

  readonly surface: MeetingCaptureSurface;

  /** This tab's view of the origin's lock table; `null` when it has none. */
  readonly lockManager: FakeLockManager | null;

  readonly locks: CaptureLocks;

  orgId: string;

  /** Every `POST /api/meetings` this tab made, in order. */
  readonly posts: CreateMeetingInput[] = [];

  readonly created: string[] = [];

  readonly warnings: string[] = [];

  readonly microphones: FakeMicrophone[] = [];

  /**
   * Every `openStore` this tab asked for, and whether it asked for PERSISTENCE.
   *
   * `openMeetingCaptureStore({ requestPersistence: true })` calls
   * `navigator.storage.persist()`, which is a permission prompt — so "did this
   * page ask the browser for something?" is a question a test has to be able to
   * put, exactly as it can for the microphone.
   */
  readonly storeOpens: boolean[] = [];

  readonly objectUrls: string[] = [];

  readonly revokedUrls: string[] = [];

  /** What the STT endpoint says for each segment; a rejection is an outage. */
  transcribeSegment: () => Promise<string> = async () => "spoken words";

  /** What the import path returns. */
  importText = "pasted words";

  /** Whether the microphone can be opened at all. */
  microphoneFails = false;

  /**
   * The microphone prompt, left on screen: `openMicrophone` waits until
   * `answerMicrophone()` — which is how long a real one can sit there, and the
   * window in which the previous build's record said nobody was recording.
   */
  microphonePending = false;

  /** The person clicks Allow. Resolves a prompt this tab is still waiting on. */
  answerMicrophone(): void {
    const answer = this.#prompt;
    this.#prompt = null;
    this.microphonePending = false;
    answer?.();
  }

  #prompt: (() => void) | null = null;

  /** A recorder that opens and then refuses to start. */
  recorderStartFails = false;

  /** The answer `window.confirm` gives. */
  confirmAnswer = true;

  /**
   * Every question this tab put to the person, in order.
   *
   * Recorded rather than merely answered because on a browser that cannot tell
   * whether another tab is recording, WHICH question was asked is the whole of
   * the guarantee: the same click either states that this delete may destroy a
   * live recording, or asks a routine "are you sure?" over the top of it.
   */
  readonly confirms: string[] = [];

  postFails: Error | null = null;

  otherBusy = false;

  #urls = 0;

  constructor(origin: CaptureOrigin, options: TabOptions = {}) {
    this.origin = origin;
    this.orgId = options.orgId ?? "org-a";
    this.lockManager = options.withoutLocks ? null : origin.locks.tab();
    this.locks = new CaptureLocks(this.lockManager);
    this.store = new MeetingCaptureStore(origin.backend, {
      persisted: true,
      // Plenty of room, so the budget never becomes the reason a test fails.
      estimate: async () => ({ usage: 1_000_000, quota: 10_000_000_000 }),
    });
    const ports: CaptureSurfacePorts = {
      locks: this.locks,
      openStore: async (requestPersistence) => {
        this.storeOpens.push(requestPersistence);
        return { store: this.store, kind: "opfs", persisted: options.persistenceRefused !== true, rejected: [] };
      },
      activeOrgId: () => this.orgId,
      openMicrophone: async () => {
        if (this.microphoneFails) throw new Error("denied");
        if (this.microphonePending) {
          await new Promise<void>((answered) => {
            this.#prompt = answered;
          });
        }
        const microphone = new FakeMicrophone();
        microphone.recorder.startFails = this.recorderStartFails;
        this.microphones.push(microphone);
        return microphone;
      },
      createTranscriber: () => async () => this.transcribeSegment(),
      createMeeting: async (input) => {
        this.posts.push(input);
        if (this.postFails) throw this.postFails;
        return { id: `mtg-${this.posts.length}` };
      },
      transcribeFile: async () => this.importText,
      legacyDraftStorage: () => options.legacyDraft ?? null,
      confirm: (question) => {
        this.confirms.push(question);
        return this.confirmAnswer;
      },
      now: () => origin.clock,
      setTimer: (run, ms) => origin.setTimer(run, ms),
      clearTimer: (handle) => origin.clearTimer(handle),
      createObjectUrl: () => {
        this.#urls += 1;
        const url = `blob:capture/${this.#urls}`;
        this.objectUrls.push(url);
        return url;
      },
      revokeObjectUrl: (url) => this.revokedUrls.push(url),
      warn: (message) => this.warnings.push(message),
      otherBusy: () => this.otherBusy,
      onCreated: (meetingId) => this.created.push(meetingId),
    };
    this.surface = new MeetingCaptureSurface(ports);
  }

  get state(): CaptureSurfaceState {
    return this.surface.snapshot();
  }

  /** The live recorder, or a failure — every test that has one needs it. */
  get recorder(): FakeRecorder {
    const microphone = this.microphones[this.microphones.length - 1];
    if (!microphone) throw new Error("this tab never opened a microphone");
    return microphone.recorder;
  }

  get microphone(): FakeMicrophone {
    const microphone = this.microphones[this.microphones.length - 1];
    if (!microphone) throw new Error("this tab never opened a microphone");
    return microphone;
  }

  /**
   * An endpoint that has taken the audio and not answered yet — the state a
   * segment spends most of its life in, and the one a test cannot reach with a
   * transcriber that resolves immediately.
   */
  deferTranscription(): { resolve(text: string): void; reject(error: Error): void } {
    let settle: (text: string) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const pending = new Promise<string>((resolveWith, rejectWith) => {
      settle = resolveWith;
      fail = rejectWith;
    });
    this.transcribeSegment = () => pending;
    return { resolve: (text) => settle(text), reject: (error) => fail(error) };
  }

  /** Press Record and let the whole start path settle. */
  async record(): Promise<void> {
    await this.surface.record();
    await flush();
  }

  /** Press Record WITHOUT waiting for it — for the microphone prompt still on screen. */
  start(): Promise<void> {
    return this.surface.record();
  }

  /**
   * Hand over audio and let it land.
   *
   * Existing scenarios use one unit-sized event so they stay focused on their
   * own lifecycle property. D9 scenarios pass the durability cadence explicitly
   * and emit several chunks before a unit boundary.
   */
  async chunk(size = 1024, fill = 7, elapsedMs = DEFAULT_MEETING_UNIT_MS): Promise<void> {
    this.origin.skip(elapsedMs);
    this.recorder.emit(audio(size, fill));
    await flush();
  }

  /** Press Stop and let the settle, the release and the reap finish. */
  async stop(): Promise<void> {
    this.surface.stop();
    await flush();
  }

  /**
   * §6's kill. NOT `dispose()`.
   *
   * The tab is gone: nothing in it runs again, no teardown happens, no Stop is
   * pressed, and the only thing that changes anywhere is that the browser drops
   * the locks this tab was holding. Everything else — the manifest, the chunks,
   * the half-written session — is left exactly as the kill found it, which is
   * the whole point of the test.
   */
  kill(): void {
    this.lockManager?.kill();
  }
}

/** Deterministic bytes, so a reassembled recording can be checked byte for byte. */
export function audio(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)]);
}

/**
 * Let every queued promise run.
 *
 * `setImmediate` runs after the whole microtask queue, and the capture path is
 * several awaits deep (store queue → queue.apply → persist → drain), so the
 * rounds are what make one press of a button reach its last write.
 */
export async function flush(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
