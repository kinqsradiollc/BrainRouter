/**
 * ADR-035 D1/D2/D6 — what a unit test can actually prove about durability.
 *
 * Not "the app survives a kill" (§6's judgement is a manual, destructive test),
 * but the three properties that test depends on and that a refactor could break
 * silently: a chunk handed to the store is on disk with the right mode, Record
 * creates the directory before any audio exists, and a session a crash left
 * mid-recording is found again on the next boot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendSegment, type MeetingCaptureSession } from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';

const POSIX = process.platform !== 'win32';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-capture-'));
}

/**
 * What the transcription supervisor does with a chunk, in the order D1 fixes:
 * the bytes, then the record that claims them, carrying the count the disk took.
 *
 * The store no longer offers this as one call, because the record belongs to the
 * transcription queue while a capture is open (`meetingTranscription.ts`) and a
 * store that also wrote it would be a second writer.
 */
async function append(
  store: MeetingCaptureStore,
  id: string,
  bytes: Uint8Array,
  durationMs: number,
): Promise<MeetingCaptureSession> {
  const { session } = await store.stored(id);
  const written = await store.writeSegment(id, session.segments.length, bytes);
  return await store.persist(appendSegment(session, { byteLength: written, durationMs }));
}

/** What the store has on disk. `stored` also carries the recorder MIME, which no assertion here wants. */
async function record(store: MeetingCaptureStore, id: string): Promise<MeetingCaptureSession> {
  return (await store.stored(id)).session;
}

function captureRoot(home: string): string {
  return path.join(home, MEETING_CAPTURE_DIRECTORY);
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

test('Record creates the capture directory before any audio exists', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: 'org_1' }, title: 'Weekly sync', template: 'standup' });

  const directory = path.join(captureRoot(home), session.id);
  assert.ok(fs.statSync(directory).isDirectory());
  assert.equal(session.status, 'recording');
  assert.deepEqual(session.segments, []);
  assert.deepEqual(session.scope, { orgId: 'org_1', workspaceId: null });
  // D6 — the directory and its record are private to this user.
  if (POSIX) assert.equal(modeOf(captureRoot(home)), 0o700);
  if (POSIX) assert.equal(modeOf(directory), 0o700);
  if (POSIX) assert.equal(modeOf(path.join(directory, 'session.json')), 0o600);

  // A capture with no audio is NOT offered back: an offer for a Record that was
  // cancelled a second later is noise a user learns to dismiss.
  assert.deepEqual(await store.resumable({ orgId: 'org_1' }), []);
});

test('a chunk handed to the store lands on disk at 0600 and is readable back', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, contentType: 'audio/webm;codecs=opus' });
  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([5, 6, 7]);

  const afterFirst = await append(store, session.id, first, 20_000);
  const afterSecond = await append(store, session.id, second, 15_000);

  const directory = path.join(captureRoot(home), session.id);
  const segment = path.join(directory, 'segment-00000.webm');
  assert.deepEqual(new Uint8Array(fs.readFileSync(segment)), first);
  if (POSIX) assert.equal(modeOf(segment), 0o600);
  if (POSIX) assert.equal(modeOf(path.join(directory, 'segment-00001.webm')), 0o600);

  assert.equal(afterFirst.segments.length, 1);
  assert.deepEqual(
    afterSecond.segments.map((entry) => [entry.index, entry.byteLength, entry.startMs, entry.endMs, entry.state]),
    [[0, 4, 0, 20_000, 'pending'], [1, 3, 20_000, 35_000, 'pending']],
  );

  // Concatenated in index order, which is the stream the recorder produced.
  const audio = await store.read(session.id);
  assert.deepEqual(audio.bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  assert.equal(audio.contentType, 'audio/webm;codecs=opus');
});

test('a segment index can only ever be written once', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });

  // The supervisor serializes appends so it never asks twice for one index; this
  // is the store's own guard behind that, and it matters because the second
  // write would be a chunk of audio silently replacing a different one.
  assert.equal(await store.writeSegment(session.id, 0, new Uint8Array([1, 2])), 2);
  await assert.rejects(() => store.writeSegment(session.id, 0, new Uint8Array([9])), /EEXIST/);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(captureRoot(home), session.id, 'segment-00000.webm'))), new Uint8Array([1, 2]));

  // And a capture that no longer exists is not recreated by writing into it: a
  // segment file in a directory with no record is the orphan the boot pass
  // deletes, so writing one would be writing audio already destined for the bin.
  await store.discard(session.id);
  await assert.rejects(() => store.writeSegment(session.id, 1, new Uint8Array([3])), /no longer on this device/);
  assert.equal(fs.existsSync(path.join(captureRoot(home), session.id)), false);
});

test('a session a crash left recording is recovered, and the chunk it never claimed is adopted', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: 'org_1' }, title: 'Interrupted' });
  await append(store, session.id, new Uint8Array([9, 9, 9]), 20_000);
  // The process dies here. D1 writes the bytes and THEN the record, so the last
  // thing a kill can interrupt is the record — leaving a chunk that is fully
  // written, closed and durable, and that the session does not mention.
  const directory = path.join(captureRoot(home), session.id);
  fs.writeFileSync(path.join(directory, 'segment-00001.webm'), Buffer.from([7]));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();

  assert.deepEqual(report.recovered, [session.id]);
  assert.deepEqual(report.adopted, [session.id]);
  assert.deepEqual(report.reaped, []);
  // ADR-028 — the status now says what is true, and nothing claims to be live.
  assert.equal((await record(next, session.id)).status, 'stopped');
  // §6 asks for "the audio up to the kill". Deleting this file was the obvious
  // reading of "torn tail" and it is the wrong one: the chunk is real audio and
  // the RECORD is the stale artifact, so the record is extended to claim it.
  assert.ok(fs.existsSync(path.join(directory, 'segment-00001.webm')));
  assert.deepEqual(
    (await record(next, session.id)).segments.map((segment) => [segment.index, segment.byteLength]),
    [[0, 3], [1, 1]],
  );

  const offers = await next.resumable({ orgId: 'org_1' });
  assert.deepEqual(offers.map((offer) => [offer.sessionId, offer.byteLength, offer.segments]), [[session.id, 4, 2]]);
  // Open question 5 — a capture started under one org is never offered under another.
  assert.deepEqual(await next.resumable({ orgId: 'org_2' }), []);
});

test('adoption stops at the first hole, and a chunk with no bytes in it is not audio', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, title: 'Holes' });
  await append(store, session.id, new Uint8Array([1, 2, 3]), 20_000);
  const directory = path.join(captureRoot(home), session.id);
  // Contiguous from the end of the record, then an `open` that beat its write,
  // then a file on the far side of the hole. Only the first may be believed: a
  // segment's INDEX is the chunk the queue reads audio from, so bridging a hole
  // would transcribe segment 2 from segment 3's audio — text that looks right
  // and is wrong, which is worse than an unclaimed chunk.
  fs.writeFileSync(path.join(directory, 'segment-00001.webm'), Buffer.from([4, 5]));
  fs.writeFileSync(path.join(directory, 'segment-00002.webm'), Buffer.alloc(0));
  fs.writeFileSync(path.join(directory, 'segment-00003.webm'), Buffer.from([6]));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();

  assert.deepEqual(report.adopted, [session.id]);
  assert.deepEqual(
    (await record(next, session.id)).segments.map((segment) => [segment.index, segment.byteLength]),
    [[0, 3], [1, 2]],
  );
  assert.ok(fs.existsSync(path.join(directory, 'segment-00001.webm')));
  assert.equal(fs.existsSync(path.join(directory, 'segment-00002.webm')), false);
  assert.equal(fs.existsSync(path.join(directory, 'segment-00003.webm')), false);
});

test('a Record that died before its first chunk is reaped instead of outliving every pass', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const cancelled = await store.begin({ scope: { orgId: null }, title: 'Cancelled' });
  const kept = await store.begin({ scope: { orgId: null }, title: 'Kept' });
  await append(store, kept.id, new Uint8Array([1, 2]), 20_000);

  // Not by THIS launch: a capture created seconds ago has no audio under it
  // either, and it is about to. Reaping it would delete a live recording's
  // directory out from under the recorder still opening its microphone.
  assert.deepEqual((await store.recoverInterrupted()).reaped, []);
  assert.ok(fs.existsSync(path.join(captureRoot(home), cancelled.id)));

  // Backdated rather than raced: the guard compares the record's `startedAt`
  // against the moment the store opened, and a test that relied on two clock
  // reads landing in different milliseconds would fail on a fast enough disk.
  const record = path.join(captureRoot(home), cancelled.id, 'session.json');
  const stored = JSON.parse(fs.readFileSync(record, 'utf8')) as { session: Record<string, unknown> };
  stored.session.startedAt = '2026-08-09T09:00:00.000Z';
  fs.writeFileSync(record, JSON.stringify(stored));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();

  // D6/D2 — `resumable` would never offer it (no bytes) and the orphan rule
  // would never claim it (it HAS a record), so without this pass it is a
  // directory that survives every launch for ever.
  assert.deepEqual(report.reaped, [cancelled.id]);
  assert.equal(fs.existsSync(path.join(captureRoot(home), cancelled.id)), false);
  assert.ok(fs.existsSync(path.join(captureRoot(home), kept.id)));
  assert.deepEqual((await next.resumable()).map((offer) => offer.sessionId), [kept.id]);
});

test('a chunk the store no longer holds reads back as missing rather than as a fault', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });
  await append(store, session.id, new Uint8Array([1, 2, 3]), 20_000);

  assert.deepEqual(await store.readSegment(session.id, 0), new Uint8Array([1, 2, 3]));
  // `null` is the word the shared segment reader understands: it becomes a
  // stated gap charged to the retry bound (D5) rather than a retry for ever
  // against a store that has nothing left to give.
  assert.equal(await store.readSegment(session.id, 7), null);
});

test('one unreadable segment costs that segment, not the whole recording', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, contentType: 'audio/webm;codecs=opus' });
  await append(store, session.id, new Uint8Array([1, 2]), 20_000);
  await append(store, session.id, new Uint8Array([3, 4]), 20_000);
  await append(store, session.id, new Uint8Array([5, 6]), 20_000);

  // The record still claims three segments — this is exactly the state §6 is
  // about, where the recovery card advertises a byte count for audio one file
  // of which the disk will not give back.
  fs.rmSync(path.join(captureRoot(home), session.id, 'segment-00001.webm'));

  const audio = await store.read(session.id);
  // Before the per-segment guard this call REJECTED, and the surface showed the
  // user an errno for a meeting whose other segments were sitting right here.
  assert.deepEqual(audio.bytes, new Uint8Array([1, 2, 5, 6]));
  assert.deepEqual(audio.missing, [1]);
  assert.equal(audio.contentType, 'audio/webm;codecs=opus');

  // …and a healthy capture says nothing is missing, so a caller can tell the
  // two apart without inspecting the bytes.
  const whole = await store.begin({ scope: { orgId: null } });
  await append(store, whole.id, new Uint8Array([7, 8]), 20_000);
  const intact = await store.read(whole.id);
  assert.deepEqual(intact.bytes, new Uint8Array([7, 8]));
  assert.deepEqual(intact.missing, []);

  // UNREADABLE IS NOT ONLY DELETED. Narrowing the guard to `ENOENT` read as a
  // principle — a permission problem is a fault worth surfacing — and was the
  // same total loss wearing a different errno: measured, a deleted file plays
  // and is reported missing, the same path replaced by a DIRECTORY threw
  // `EISDIR`, and mode `000` threw `EACCES`. Each of those took the whole read
  // down with it. D5's answer to audio that will not read is a stated gap,
  // whatever the reason it will not read.
  const blocked = path.join(captureRoot(home), session.id, 'segment-00002.webm');
  fs.rmSync(blocked);
  fs.mkdirSync(blocked);
  assert.equal(await store.readSegment(session.id, 2), null);
  const eisdir = await store.read(session.id);
  assert.deepEqual(eisdir.bytes, new Uint8Array([1, 2]));
  assert.deepEqual(eisdir.missing, [1, 2]);

  // `chmod 000` is meaningless as root, and POSIX modes do not exist on Windows.
  if (POSIX && process.getuid?.() !== 0) {
    const locked = path.join(captureRoot(home), whole.id, 'segment-00000.webm');
    fs.chmodSync(locked, 0o000);
    try {
      assert.equal(await store.readSegment(whole.id, 0), null);
      const eacces = await store.read(whole.id);
      assert.equal(eacces.bytes.byteLength, 0);
      assert.deepEqual(eacces.missing, [0]);
    } finally { fs.chmodSync(locked, 0o600); }
  }
});

test('a discarded capture is really deleted and never offered again', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const kept = await store.begin({ scope: { orgId: null }, title: 'Kept' });
  await append(store, kept.id, new Uint8Array([1, 2]), 20_000);
  const thrown = await store.begin({ scope: { orgId: null }, title: 'Thrown away' });
  await append(store, thrown.id, new Uint8Array([3, 4]), 20_000);

  await store.discard(thrown.id);
  assert.equal(fs.existsSync(path.join(captureRoot(home), thrown.id)), false);
  assert.deepEqual((await store.resumable()).map((offer) => offer.sessionId), [kept.id]);

  // D6 — accepting the meeting releases the audio the same way.
  await store.finalize(kept.id);
  assert.equal(fs.existsSync(path.join(captureRoot(home), kept.id)), false);
  assert.deepEqual(await store.resumable(), []);
});

test('a discard the process did not live to finish is completed at the next boot', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const thrown = await store.begin({ scope: { orgId: null }, title: 'Thrown away' });
  await append(store, thrown.id, new Uint8Array([1, 2, 3]), 20_000);
  const directory = path.join(captureRoot(home), thrown.id);
  const record = path.join(directory, 'session.json');
  // `close` writes the terminal status and THEN deletes; the app is killed
  // between the two, which is the state this leaves on disk.
  const stored = JSON.parse(fs.readFileSync(record, 'utf8')) as { session: Record<string, unknown> };
  stored.session.status = 'discarded';
  stored.session.closedAt = new Date().toISOString();
  fs.writeFileSync(record, JSON.stringify(stored));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();

  // D6 — audio the user threw away is gone, and the reap is reported so it can
  // be logged. Nothing else in the app would ever have retried this delete.
  assert.deepEqual(report.reaped, [thrown.id]);
  assert.deepEqual(report.recovered, []);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(await next.resumable(), []);
});

test('a chunk that only partly reached the disk fails the append instead of being recorded', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });
  const target = fs.promises as { open: typeof fs.promises.open };
  const realOpen = target.open;
  // The ENOSPC boundary in miniature: `write` RESOLVES having taken fewer bytes
  // than it was given, which is the case a caller that trusted it would record
  // as a full segment.
  target.open = (async (file: fs.PathLike, flags?: unknown, mode?: unknown) => {
    const handle = await realOpen(file, flags as number, mode as number);
    const write = handle.write.bind(handle);
    handle.write = (async (bytes: Uint8Array) => {
      const result = await write(bytes.subarray(0, 1));
      return { bytesWritten: result.bytesWritten, buffer: bytes };
    }) as typeof handle.write;
    return handle;
  }) as typeof fs.promises.open;

  try {
    await assert.rejects(() => append(store, session.id, new Uint8Array([1, 2, 3, 4]), 20_000), /reached the disk/);
  } finally { target.open = realOpen; }

  // The record never claims audio the disk did not take, and the truncated file
  // does not hold the index against a retry.
  assert.deepEqual((await record(store, session.id)).segments, []);
  assert.equal(fs.existsSync(path.join(captureRoot(home), session.id, 'segment-00000.webm')), false);
  const retried = await append(store, session.id, new Uint8Array([1, 2, 3, 4]), 20_000);
  assert.deepEqual(retried.segments.map((entry) => [entry.index, entry.byteLength]), [[0, 4]]);
});

test('a capture directory with no session record is reaped at boot', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const live = await store.begin({ scope: { orgId: null } });
  await append(store, live.id, new Uint8Array([1]), 20_000);
  const orphan = path.join(captureRoot(home), 'mtg-orphaned-capture');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'segment-00000.webm'), Buffer.from([1, 2, 3]));

  const report = await store.recoverInterrupted();

  assert.deepEqual(report.reaped, ['mtg-orphaned-capture']);
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(fs.existsSync(path.join(captureRoot(home), live.id)));
});

test('a capture id that is not path-safe is refused before it becomes a path', async () => {
  const store = new MeetingCaptureStore(userData());
  await assert.rejects(() => store.stored('../../etc'), /not a meeting capture id/);
  await assert.rejects(() => append(store, '..', new Uint8Array([1]), 20_000), /not a meeting capture id/);
});
