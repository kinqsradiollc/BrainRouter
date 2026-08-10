/**
 * ADR-035 D1/D2 — a wiring test, because the defect it guards typechecks.
 *
 * Every failure this ADR exists to end is invisible to a unit test of any single
 * module: a recorder started without a timeslice still records, an
 * `ondataavailable` that pushes into an array still compiles, and a capture
 * channel that main never registers still has a preload method to call. What is
 * being asserted is that the pieces are connected to each other in the one
 * arrangement where the bytes survive.
 *
 * Asserted against source text and living under `src/` for the same reason as
 * the org-partition contract: this half of the desktop suite runs from SOURCE,
 * while the electron half runs from `dist-electron`, where no `.ts` file exists
 * to read.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('meeting audio is written on a cadence, through the host, and never held in the renderer', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const recorder = read('../components/meetings/captureRecorder.ts');
  const ops = read('../components/meetings/captureOps.ts');

  // D1 — the timeslice. Without an argument here `MediaRecorder` is free to
  // deliver one blob at stop, and the disk write buys nothing.
  assert.match(recorder, /recorder\.start\(this\.segmentMs\)/);
  assert.match(recorder, /segmentMs = options\.segmentMs \?\? DEFAULT_MEETING_SEGMENT_MS/);

  // D1 — a chunk goes straight to the host. There is no array of blobs anywhere.
  assert.match(recorder, /ondataavailable = \(event: BlobEvent\) =>[\s\S]{0,120}this\.enqueue\(sessionId, event\.data\)/);
  assert.match(recorder, /await this\.capture\.append\(sessionId, bytes, durationMs\)/);
  assert.doesNotMatch(recorder, /Blob\[\]|\.push\(/);
  assert.doesNotMatch(view, /chunksRef|Blob\[\]/);
  // The view no longer owns a recorder or a stream; both moved behind the class
  // that cannot accumulate audio.
  assert.doesNotMatch(view, /new MediaRecorder\(/);
  assert.doesNotMatch(view, /streamRef/);
  assert.match(view, /new MeetingCaptureRecorder\(\{ capture, onChunkError: setError \}\)/);

  // D2 — the session (and its directory) exists before the recorder is started.
  const beginAt = recorder.indexOf('await this.capture.begin(');
  const startAt = recorder.indexOf('recorder.start(this.segmentMs)');
  assert.ok(beginAt > 0 && startAt > beginAt);

  // The renderer holds no filesystem path and no audio buffer: its only route to
  // durability is the bridge, and it refuses to record when that route is absent.
  assert.match(ops, /captureAppend!\(id, bytes, durationMs\)/);
  assert.match(view, /if \(!capture\.available\)/);

  // D2 — the offer is queried where the user lands after a crash (the library),
  // not only inside a compose form they would have to think to open.
  assert.match(view, /capture\.resumable\(\{ orgId: scopedOrgId \?\? null \}\)/);
  assert.match(view, /capture\.resumable\(captureScope\)/);
});

test('the capture channels exist on both sides of the Electron boundary', () => {
  const main = read('../../electron/main.ts');
  const bridge = read('../../electron/meetingCaptureBridge.ts');
  const preload = read('../../electron/preload.cts');
  const declarations = read('../bridge.d.ts');

  // Registered in main, which outlives a renderer crash — that is the whole
  // reason the write does not happen in the renderer.
  assert.match(main, /registerMeetingCaptureBridge\(\)/);
  for (const channel of ['captureBegin', 'captureAppend', 'captureStop', 'captureRead', 'captureFinalize', 'captureDiscard', 'captureResumable']) {
    assert.match(bridge, new RegExp(`ipcMain\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }

  // D2/D6 — the boot pass runs at registration, before any window can Record.
  assert.match(bridge, /store\.recoverInterrupted\(\)/);
});

test('captured audio is written 0700/0600 under the existing app-data root', () => {
  const store = read('../../electron/meetingCapture.ts');
  const bridge = read('../../electron/meetingCaptureBridge.ts');

  // D6 — the modes are the point, and mkdir/open honour the umask, so both are
  // set explicitly at creation and again afterwards.
  assert.match(store, /DIRECTORY_MODE = 0o700/);
  assert.match(store, /FILE_MODE = 0o600/);
  assert.match(store, /mkdir\(directory, \{ mode: DIRECTORY_MODE \}\)/);
  assert.match(store, /chmodQuiet\(directory, DIRECTORY_MODE\)/);
  assert.match(store, /O_EXCL/);
  assert.match(store, /O_NOFOLLOW/);

  // Open question 2 — an existing rooted location, not a new one.
  assert.match(bridge, /app\.getPath\('userData'\)/);

  // D1 — bytes first, record second: the segment file is written before the
  // session record claims it exists.
  const writeAt = store.indexOf('await writeSegmentFile(');
  const recordAt = store.indexOf('const session = appendSegment(');
  assert.ok(writeAt > 0 && recordAt > writeAt);
});
