/**
 * ADR-035 D1/D9 — the two properties that make a recording survivable, tested
 * without a microphone: the recorder is started with a timeslice, and every
 * chunk it produces is handed to the host instead of being kept.
 *
 * The timeslice assertion is the one that looks trivial and is not. Without an
 * argument, `MediaRecorder` may deliver a single blob at `stop`, and every other
 * line of this feature — the capture directory, the chunk ledger, the
 * recovery offer — would still be there and would still lose the meeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendChunk,
  DEFAULT_MEETING_CHUNK_MS,
  describeMeetingRetention,
  MEETING_AUDIO_BITS_PER_SECOND,
  MEETING_RETENTION_DAY_CHOICES,
  MEETING_RETENTION_DEFAULT_DAYS,
  sealDueUnits,
  type MeetingCaptureSession,
} from "@kinqs/brainrouter-core/meetings";
import type { MeetingCaptureOps, MeetingRetentionSetting } from "./captureOps.js";
import { CaptureCancelledError, MeetingCaptureRecorder, MicrophoneUnavailableError } from "./captureRecorder.js";

class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  timeslice: number | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  private readonly tail: number[];

  constructor(tail: number[] = []) { this.tail = tail; }

  start(timeslice?: number): void { this.timeslice = timeslice; this.state = "recording"; }
  pause(): void { this.state = "paused"; }
  resume(): void { this.state = "recording"; }
  stop(): void {
    // A real recorder flushes one last chunk before it announces the stop.
    if (this.tail.length) this.emit(this.tail);
    this.state = "inactive";
    this.onstop?.();
  }
  emit(bytes: number[]): void { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
}

const RETENTION: MeetingRetentionSetting = {
  days: MEETING_RETENTION_DEFAULT_DAYS,
  choices: MEETING_RETENTION_DAY_CHOICES,
  description: describeMeetingRetention(MEETING_RETENTION_DEFAULT_DAYS),
};

interface Recorded {
  appended: Array<{ id: string; bytes: number[]; durationMs: number }>;
  /** Captures the store actually created — what main would have registered a writer for. */
  begun: string[];
  stopped: string[];
  discarded: string[];
  ops: MeetingCaptureOps;
}

function fakeCapture(begin?: () => Promise<MeetingCaptureSession>): Recorded {
  const appended: Recorded["appended"] = [];
  const begun: string[] = [];
  const stopped: string[] = [];
  const discarded: string[] = [];
  const session = (id: string): MeetingCaptureSession =>
    ({ id, startedAt: "2026-01-01T00:00:00.000Z", scope: { orgId: null, workspaceId: null }, title: "Sync", template: "general", status: "recording", segments: [] });
  const create = begin ?? (async () => session("mtg-test"));
  return {
    appended,
    begun,
    stopped,
    discarded,
    ops: {
      available: true,
      begin: async () => { const created = await create(); begun.push(created.id); return created; },
      append: async (id, bytes, durationMs) => { appended.push({ id, bytes: [...bytes], durationMs }); return session(id); },
      stop: async (id) => { stopped.push(id); return { ...session(id), status: "stopped" }; },
      read: async () => ({ bytes: new Uint8Array(), contentType: "audio/webm", missing: [] }),
      // The recorder never asks the host to transcribe or to retry — that is the
      // compose view's business — so these exist only to satisfy the port.
      adopt: async (id) => session(id),
      retrySegment: async (id) => session(id),
      onProgress: () => () => undefined,
      finalize: async () => undefined,
      discard: async (id) => { discarded.push(id); },
      resumable: async () => [],
      // Nor does it ask who is recording (D6): that is the compose view's
      // question, and the recorder's job is to have nowhere to put a chunk.
      writing: async () => [],
      onWriters: () => () => undefined,
      holderId: "wr-recorder-test",
      // Nor does it touch the compose draft (D6): the recorder handles audio,
      // and the draft is text the person owns.
      draftAvailable: true,
      readDraft: async () => null,
      writeDraft: async () => undefined,
      clearDraft: async () => undefined,
      // D6 — nor the retention window: the recorder writes audio, and how long
      // that audio is kept is a policy the store applies to it afterwards.
      retentionAvailable: true,
      readRetention: async () => RETENTION,
      writeRetention: async () => RETENTION,
    },
  };
}

function tracked(): { stream: MediaStream; stops: number } {
  const state = { stops: 0 };
  const stream = { getTracks: () => [{ stop: () => { state.stops += 1; } }] } as unknown as MediaStream;
  return { get stops() { return state.stops; }, stream };
}

test("D9 the recorder writes on the durability cadence rather than the transcription-unit cadence", async () => {
  const capture = fakeCapture();
  const fake = new FakeRecorder();
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
  });

  const id = await recorder.start({ scope: { orgId: null } });

  assert.equal(id, "mtg-test");
  assert.equal(fake.timeslice, DEFAULT_MEETING_CHUNK_MS);
  assert.ok(typeof fake.timeslice === "number");
  assert.ok(fake.timeslice >= 2_000 && fake.timeslice <= 5_000, "a kill can cost only the bounded write cadence");
  assert.equal(fake.state, "recording");
});

test("every chunk is written through the host, in order, and none is kept", async () => {
  const capture = fakeCapture();
  const fake = new FakeRecorder([7, 7]);
  let clock = 1_000;
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
    now: () => clock,
  });
  await recorder.start({ scope: { orgId: null }, title: "Sync" });

  clock = 4_000;
  fake.emit([1, 2]);
  clock = 7_000;
  fake.emit([3]);
  // A zero-byte chunk is not durable audio: the shared model refuses one, and
  // recording it would make "there is audio" true for a session with none.
  fake.emit([]);
  clock = 9_000;

  const stopped = await recorder.stop();

  assert.equal(stopped, "mtg-test");
  assert.deepEqual(capture.appended, [
    { id: "mtg-test", bytes: [1, 2], durationMs: 3_000 },
    { id: "mtg-test", bytes: [3], durationMs: 3_000 },
    { id: "mtg-test", bytes: [7, 7], durationMs: 2_000 },
  ]);
  // The capture is marked stopped only AFTER the final chunk is on disk.
  assert.deepEqual(capture.stopped, ["mtg-test"]);
  // Stopping released the capture: a second stop has nothing to close and says
  // so, rather than closing the same session twice. Asserted through the public
  // surface because there is no test-only accessor for the id.
  assert.equal(await recorder.stop(), null);
  assert.deepEqual(capture.stopped, ["mtg-test"]);
});

test("a long pause is excluded from the next chunk's duration and cannot seal a unit", async () => {
  const fake = new FakeRecorder();
  let clock = 1_000;
  let current: MeetingCaptureSession = {
    id: "mtg-paused",
    startedAt: "2026-01-01T00:00:00.000Z",
    scope: { orgId: null, workspaceId: null },
    title: "Paused sync",
    template: "general",
    status: "recording",
    segments: [],
    chunks: [],
  };
  const durations: number[] = [];
  const capture = fakeCapture();
  const recorder = new MeetingCaptureRecorder({
    capture: {
      ...capture.ops,
      begin: async () => current,
      append: async (_id, bytes, durationMs) => {
        durations.push(durationMs);
        current = sealDueUnits(appendChunk(current, { byteLength: bytes.byteLength, durationMs }));
        return current;
      },
    },
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
    now: () => clock,
  });
  await recorder.start({ scope: { orgId: null } });

  recorder.pause();
  clock += 60 * 60 * 1_000;
  recorder.resume();
  clock += 3_000;
  fake.emit([1, 2, 3]);
  await recorder.settled();

  assert.deepEqual(durations, [3_000], "paused wall-clock time is not recorded as audio duration");
  assert.deepEqual(current.chunks?.map((chunk) => [chunk.startMs, chunk.endMs]), [[0, 3_000]]);
  assert.deepEqual(current.segments, [], "three active seconds remain an open tail, not a due transcription unit");
});

test("a blob delivered while paused uses the frozen active clock, not paused wall time", async () => {
  const fake = new FakeRecorder();
  let clock = 1_000;
  let current: MeetingCaptureSession = {
    id: "mtg-paused-event",
    startedAt: "2026-01-01T00:00:00.000Z",
    scope: { orgId: null, workspaceId: null },
    title: "Paused event sync",
    template: "general",
    status: "recording",
    segments: [],
    chunks: [],
  };
  const durations: number[] = [];
  const capture = fakeCapture();
  const recorder = new MeetingCaptureRecorder({
    capture: {
      ...capture.ops,
      begin: async () => current,
      append: async (_id, bytes, durationMs) => {
        durations.push(durationMs);
        current = sealDueUnits(appendChunk(current, { byteLength: bytes.byteLength, durationMs }));
        return current;
      },
    },
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
    now: () => clock,
  });
  await recorder.start({ scope: { orgId: null } });

  clock = 4_000;
  recorder.pause();
  clock += 60 * 60 * 1_000;
  fake.emit([1]);
  await recorder.settled();
  recorder.resume();
  clock += 3_000;
  fake.emit([2]);
  await recorder.settled();

  assert.deepEqual(durations, [3_000, 3_000], "the event during pause stops at the pause boundary");
  assert.deepEqual(current.chunks?.map((chunk) => [chunk.startMs, chunk.endMs]), [[0, 3_000], [3_000, 6_000]]);
  assert.deepEqual(current.segments, [], "paused wall time cannot manufacture a due transcription unit");
});

test("a failed resume keeps the whole pause excluded when a later resume succeeds", async () => {
  const fake = new FakeRecorder();
  let clock = 1_000;
  let current: MeetingCaptureSession = {
    id: "mtg-resume-retry",
    startedAt: "2026-01-01T00:00:00.000Z",
    scope: { orgId: null, workspaceId: null },
    title: "Resume retry sync",
    template: "general",
    status: "recording",
    segments: [],
    chunks: [],
  };
  const durations: number[] = [];
  const capture = fakeCapture();
  const recorder = new MeetingCaptureRecorder({
    capture: {
      ...capture.ops,
      begin: async () => current,
      append: async (_id, bytes, durationMs) => {
        durations.push(durationMs);
        current = sealDueUnits(appendChunk(current, { byteLength: bytes.byteLength, durationMs }));
        return current;
      },
    },
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
    now: () => clock,
  });
  await recorder.start({ scope: { orgId: null } });

  clock = 4_000;
  fake.emit([1]);
  await recorder.settled();
  recorder.pause();

  let rejectResume = true;
  fake.resume = () => {
    if (rejectResume) throw new Error("resume failed");
    fake.state = "recording";
  };
  clock += 60 * 60 * 1_000;
  assert.throws(() => recorder.resume(), /resume failed/);
  assert.equal(recorder.paused, true, "a rejected platform resume leaves the recorder paused");

  rejectResume = false;
  clock += 30 * 60 * 1_000;
  recorder.resume();
  clock += 3_000;
  fake.emit([2]);
  await recorder.settled();

  assert.deepEqual(durations, [3_000, 3_000], "both failed and successful resume attempts stay outside active time");
  assert.deepEqual(current.chunks?.map((chunk) => [chunk.startMs, chunk.endMs]), [[0, 3_000], [3_000, 6_000]]);
  assert.deepEqual(current.segments, [], "a failed resume cannot manufacture a due transcription unit");
});

test("a failed pause rolls back the frozen clock and capture remains continuous", async () => {
  const fake = new FakeRecorder();
  const capture = fakeCapture();
  let clock = 1_000;
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
    now: () => clock,
  });
  await recorder.start({ scope: { orgId: null } });

  fake.pause = () => { throw new Error("pause failed"); };
  clock = 4_000;
  assert.throws(() => recorder.pause(), /pause failed/);
  assert.equal(fake.state, "recording");
  assert.equal(recorder.paused, false);

  clock = 7_000;
  fake.emit([1]);
  await recorder.settled();
  assert.deepEqual(capture.appended, [
    { id: "mtg-test", bytes: [1], durationMs: 6_000 },
  ], "the failed pause boundary is not retained as a false duration cutoff");
});

test("a chunk that cannot be written is reported while the meeting is still running", async () => {
  const capture = fakeCapture();
  const failures: string[] = [];
  const fake = new FakeRecorder();
  const recorder = new MeetingCaptureRecorder({
    capture: { ...capture.ops, append: async () => { throw new Error("The disk is full."); } },
    onChunkError: (message) => failures.push(message),
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
  });
  await recorder.start({ scope: { orgId: null } });

  fake.emit([1]);
  await recorder.settled();

  assert.deepEqual(failures, ["The disk is full."]);
});

test("stopping releases the session, so the next Record is not refused", async () => {
  const capture = fakeCapture();
  const fakes: FakeRecorder[] = [];
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => tracked().stream,
    createRecorder: () => { const next = new FakeRecorder(); fakes.push(next); return next as unknown as MediaRecorder; },
  });

  await recorder.start({ scope: { orgId: null } });
  // A second Record while one is running is refused BY THE SESSION ID. That is
  // the field, and clearing it is what `stop` has to do.
  await assert.rejects(() => recorder.start({ scope: { orgId: null } }), /already being captured/);
  await recorder.stop();

  // Asserted through the effect the field HAS, not through a second `stop`:
  // `stop` also nulls `this.recorder`, so a second call answers `null` down that
  // branch whether or not the id was released — and a recorder still holding one
  // refuses every later Record with "a meeting is already being captured", which
  // is the microphone never opening again for the rest of the session.
  assert.equal(await recorder.start({ scope: { orgId: null } }), "mtg-test");
  assert.equal(fakes.length, 2);
  assert.equal(fakes[1]?.state, "recording");
});

test("a recorder that will not start releases the microphone rather than leaving it open", async () => {
  const capture = fakeCapture();
  const microphone = tracked();
  let broken = true;
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => microphone.stream,
    createRecorder: () => {
      const fake = new FakeRecorder();
      // `NotSupportedError`: the stream went inactive between `getUserMedia` and
      // here — an interface unplugged, a device the OS took back. It is the LAST
      // statement of `start`, after the stream, the recorder and the session id
      // have all been stored, so an escape leaves this object holding a live
      // microphone that the caller never receives a handle to.
      if (broken) fake.start = () => { throw new Error("NotSupportedError"); };
      return fake as unknown as MediaRecorder;
    },
  });

  await assert.rejects(() => recorder.start({ scope: { orgId: null } }), MicrophoneUnavailableError);
  // A recording light that never goes out, for a meeting nothing is capturing.
  assert.equal(microphone.stops, 1);
  // …and the capture goes back too. `begin` had already returned, so main has
  // registered this window as its writer; a claim nothing releases hides that
  // capture from every window's offer and refuses it to every other window for
  // the life of the process, over a recording that never started.
  assert.deepEqual(capture.discarded, ["mtg-test"]);

  // …and the id goes back with it, or this window can never record again.
  broken = false;
  assert.equal(await recorder.start({ scope: { orgId: null } }), "mtg-test");
});

/**
 * G1 — `start` crosses two awaits, and a caller may go away across either.
 *
 * `getUserMedia` sits on a permission prompt for as long as the person takes to
 * answer it, and leaving Meetings during that used to be ignored entirely: the
 * microphone opened, the recorder started on a view that no longer existed, and
 * main went on claiming the capture under a holder id whose window was gone —
 * filtered out of every offer by `isWriting`, dropped from its own window's
 * writers panel as "mine", and refused to every other window. The two tests
 * below are the two awaits.
 */
test("a teardown while the microphone prompt is up starts nothing at all", async () => {
  const capture = fakeCapture();
  const microphone = tracked();
  let answerPrompt = (): void => undefined;
  const prompt = new Promise<MediaStream>((resolve) => { answerPrompt = () => resolve(microphone.stream); });
  const fakes: FakeRecorder[] = [];
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: () => prompt,
    createRecorder: () => { const next = new FakeRecorder(); fakes.push(next); return next as unknown as MediaRecorder; },
  });

  const starting = recorder.start({ scope: { orgId: null } });
  // The person leaves Meetings. There is nothing to stop yet, which is exactly
  // why this used to do nothing — and why it has to cancel instead.
  assert.equal(await recorder.stop(), null);
  answerPrompt();

  await assert.rejects(() => starting, CaptureCancelledError);
  assert.deepEqual(fakes, [], "no recorder was ever constructed");
  assert.deepEqual(capture.begun, [], "no capture was created, so none is claimed");
  // The microphone the prompt opened is handed straight back rather than left
  // live for a recording nobody is making.
  assert.equal(microphone.stops, 1);
});

test("a capture created after the caller went away is handed back, not abandoned", async () => {
  const capture = fakeCapture();
  const microphone = tracked();
  let acknowledge = (): void => undefined;
  const pending = new Promise<void>((resolve) => { acknowledge = resolve; });
  const fakes: FakeRecorder[] = [];
  const recorder = new MeetingCaptureRecorder({
    // The store is the SECOND await, and the one that leaves something behind.
    capture: { ...capture.ops, begin: async (input) => { await pending; return await capture.ops.begin(input); } },
    openStream: async () => microphone.stream,
    createRecorder: () => { const next = new FakeRecorder(); fakes.push(next); return next as unknown as MediaRecorder; },
  });

  const starting = recorder.start({ scope: { orgId: null } });
  // Let the microphone answer, so the teardown lands on the store's await rather
  // than on the prompt's.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(await recorder.stop(), null);
  acknowledge();

  await assert.rejects(() => starting, CaptureCancelledError);
  assert.deepEqual(capture.begun, ["mtg-test"], "the capture really was created");
  assert.equal(fakes[0]?.state, "inactive", "and the recorder was never started");
  assert.equal(microphone.stops, 1);
  // THE POINT. `begin` is where main registers this window as the capture's
  // writer, and none of the four removals — Stop, close, the window going away,
  // a failed Record — is reached by a `start` that simply threw. The claim would
  // outlive the failure by the whole life of the process.
  assert.deepEqual(capture.discarded, ["mtg-test"]);
});

test("a cancelled attempt leaves the recorder usable, because the next Record is the same object", async () => {
  const capture = fakeCapture();
  const microphone = tracked();
  let answerPrompt = (): void => undefined;
  const prompt = new Promise<MediaStream>((resolve) => { answerPrompt = () => resolve(microphone.stream); });
  let opens = 0;
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: () => { opens += 1; return opens === 1 ? prompt : Promise.resolve(tracked().stream); },
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
  });

  const starting = recorder.start({ scope: { orgId: null } });
  await recorder.stop();
  answerPrompt();
  await assert.rejects(() => starting, CaptureCancelledError);

  // What is cancelled is one ATTEMPT, not the recorder: `stop` has to leave this
  // object able to record again, or a person who changed their mind at the
  // permission prompt would find Record dead for the rest of the window's life.
  assert.equal(await recorder.start({ scope: { orgId: null } }), "mtg-test");
});

test("a microphone that will not open, and a store that will not begin, both release the stream", async () => {
  const capture = fakeCapture(async () => { throw new Error("No capture directory."); });
  const microphone = tracked();
  const denied = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => { throw new Error("NotAllowedError"); },
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
  });
  await assert.rejects(() => denied.start({ scope: { orgId: null } }), MicrophoneUnavailableError);

  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => microphone.stream,
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
  });
  await assert.rejects(() => recorder.start({ scope: { orgId: null } }), /No capture directory/);
  assert.equal(microphone.stops, 1);
  // A failed start claimed no capture, so there is nothing to stop and nothing
  // to close — a recorder left holding a half-started id would refuse the next
  // Record with "a meeting is already being captured".
  assert.equal(await recorder.stop(), null);
  assert.deepEqual(capture.stopped, []);
});
