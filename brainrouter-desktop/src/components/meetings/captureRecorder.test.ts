/**
 * ADR-035 D1 — the two properties that make a recording survivable, tested
 * without a microphone: the recorder is started with a timeslice, and every
 * chunk it produces is handed to the host instead of being kept.
 *
 * The timeslice assertion is the one that looks trivial and is not. Without an
 * argument, `MediaRecorder` may deliver a single blob at `stop`, and every other
 * line of this feature — the capture directory, the per-segment records, the
 * recovery offer — would still be there and would still lose the meeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEETING_SEGMENT_MS, type MeetingCaptureSession } from "@kinqs/brainrouter-core/meetings";
import type { MeetingCaptureOps } from "./captureOps.js";
import { MeetingCaptureRecorder, MicrophoneUnavailableError } from "./captureRecorder.js";

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

interface Recorded {
  appended: Array<{ id: string; bytes: number[]; durationMs: number }>;
  stopped: string[];
  ops: MeetingCaptureOps;
}

function fakeCapture(begin?: () => Promise<MeetingCaptureSession>): Recorded {
  const appended: Recorded["appended"] = [];
  const stopped: string[] = [];
  const session = (id: string): MeetingCaptureSession =>
    ({ id, startedAt: "2026-01-01T00:00:00.000Z", scope: { orgId: null, workspaceId: null }, title: "Sync", template: "general", status: "recording", segments: [] });
  return {
    appended,
    stopped,
    ops: {
      available: true,
      begin: begin ?? (async () => session("mtg-test")),
      append: async (id, bytes, durationMs) => { appended.push({ id, bytes: [...bytes], durationMs }); return session(id); },
      stop: async (id) => { stopped.push(id); return { ...session(id), status: "stopped" }; },
      read: async () => ({ bytes: new Uint8Array(), contentType: "audio/webm" }),
      // The recorder never asks the host to transcribe or to retry — that is the
      // compose view's business — so these exist only to satisfy the port.
      adopt: async (id) => session(id),
      retrySegment: async (id) => session(id),
      onProgress: () => () => undefined,
      finalize: async () => undefined,
      discard: async () => undefined,
      resumable: async () => [],
    },
  };
}

function tracked(): { stream: MediaStream; stops: number } {
  const state = { stops: 0 };
  const stream = { getTracks: () => [{ stop: () => { state.stops += 1; } }] } as unknown as MediaStream;
  return { get stops() { return state.stops; }, stream };
}

test("the recorder is started with an explicit segment timeslice", async () => {
  const capture = fakeCapture();
  const fake = new FakeRecorder();
  const recorder = new MeetingCaptureRecorder({
    capture: capture.ops,
    openStream: async () => tracked().stream,
    createRecorder: () => fake as unknown as MediaRecorder,
  });

  const id = await recorder.start({ scope: { orgId: null } });

  assert.equal(id, "mtg-test");
  assert.equal(fake.timeslice, DEFAULT_MEETING_SEGMENT_MS);
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

  clock = 21_000;
  fake.emit([1, 2]);
  clock = 41_000;
  fake.emit([3]);
  // A zero-byte chunk is not a segment: the shared model refuses one, and
  // recording it would make "there is audio" true for a session with none.
  fake.emit([]);
  clock = 47_000;

  const stopped = await recorder.stop();

  assert.equal(stopped, "mtg-test");
  assert.deepEqual(capture.appended, [
    { id: "mtg-test", bytes: [1, 2], durationMs: 20_000 },
    { id: "mtg-test", bytes: [3], durationMs: 20_000 },
    { id: "mtg-test", bytes: [7, 7], durationMs: 6_000 },
  ]);
  // The capture is marked stopped only AFTER the final chunk is on disk.
  assert.deepEqual(capture.stopped, ["mtg-test"]);
  assert.equal(recorder.activeSessionId, null);
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
  assert.equal(recorder.activeSessionId, null);
});
