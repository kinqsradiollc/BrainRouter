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
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';

const POSIX = process.platform !== 'win32';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-capture-'));
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

  const afterFirst = await store.append(session.id, first, 20_000);
  const afterSecond = await store.append(session.id, second, 15_000);

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

test('overlapping appends are serialized rather than overwriting one another', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });

  await Promise.all([
    store.append(session.id, new Uint8Array([1]), 1_000),
    store.append(session.id, new Uint8Array([2]), 1_000),
    store.append(session.id, new Uint8Array([3]), 1_000),
  ]);

  const stored = await store.session(session.id);
  assert.deepEqual(stored.segments.map((entry) => entry.index), [0, 1, 2]);
  assert.equal((await store.read(session.id)).bytes.byteLength, 3);
});

test('a session a crash left recording is recovered and offered back with its audio', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: 'org_1' }, title: 'Interrupted' });
  await store.append(session.id, new Uint8Array([9, 9, 9]), 20_000);
  // The process dies here: the record still says `recording`, and a segment file
  // written after the last record update is a torn tail nothing accounts for.
  const directory = path.join(captureRoot(home), session.id);
  fs.writeFileSync(path.join(directory, 'segment-00001.webm'), Buffer.from([7]));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();

  assert.deepEqual(report.recovered, [session.id]);
  assert.deepEqual(report.reaped, []);
  // ADR-028 — the status now says what is true, and nothing claims to be live.
  assert.equal((await next.session(session.id)).status, 'stopped');
  assert.equal(fs.existsSync(path.join(directory, 'segment-00001.webm')), false);

  const offers = await next.resumable({ orgId: 'org_1' });
  assert.deepEqual(offers.map((offer) => [offer.sessionId, offer.byteLength, offer.segments]), [[session.id, 3, 1]]);
  // Open question 5 — a capture started under one org is never offered under another.
  assert.deepEqual(await next.resumable({ orgId: 'org_2' }), []);
});

test('a discarded capture is really deleted and never offered again', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const kept = await store.begin({ scope: { orgId: null }, title: 'Kept' });
  await store.append(kept.id, new Uint8Array([1, 2]), 20_000);
  const thrown = await store.begin({ scope: { orgId: null }, title: 'Thrown away' });
  await store.append(thrown.id, new Uint8Array([3, 4]), 20_000);

  await store.discard(thrown.id);
  assert.equal(fs.existsSync(path.join(captureRoot(home), thrown.id)), false);
  assert.deepEqual((await store.resumable()).map((offer) => offer.sessionId), [kept.id]);

  // D6 — accepting the meeting releases the audio the same way.
  await store.finalize(kept.id);
  assert.equal(fs.existsSync(path.join(captureRoot(home), kept.id)), false);
  assert.deepEqual(await store.resumable(), []);
});

test('a capture directory with no session record is reaped at boot', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const live = await store.begin({ scope: { orgId: null } });
  await store.append(live.id, new Uint8Array([1]), 20_000);
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
  await assert.rejects(() => store.session('../../etc'), /not a meeting capture id/);
  await assert.rejects(() => store.append('..', new Uint8Array([1]), 20_000), /not a meeting capture id/);
});
