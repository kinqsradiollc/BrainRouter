/**
 * ADR-035 D1/D2/D6/D9 — what a unit test can actually prove about durability.
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
import {
  appendChunk as recordChunk,
  appendSegment,
  isMeetingCaptureSession,
  nextChunkSequence,
  sealDueUnits,
  type MeetingCaptureSession,
} from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import { MeetingTranscriptionSupervisor } from './meetingTranscription.js';

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
  const written = await store.writeSegment(id, nextChunkSequence(session), bytes);
  return await store.persist(appendSegment(session, { byteLength: written, durationMs }));
}

/** D9's real write path: persist a short chunk, then seal only when a unit is due. */
async function appendDurabilityChunk(
  store: MeetingCaptureStore,
  id: string,
  bytes: Uint8Array,
  durationMs = 3_000,
): Promise<MeetingCaptureSession> {
  const { session } = await store.stored(id);
  const sequence = nextChunkSequence(session);
  const written = await store.writeSegment(id, sequence, bytes);
  return await store.persist(sealDueUnits(recordChunk(session, { byteLength: written, durationMs })));
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

test('D9 playback assembles every chunk in a multi-chunk transcription unit', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, contentType: 'audio/webm;codecs=opus' });

  for (let sequence = 0; sequence < 7; sequence += 1) {
    await appendDurabilityChunk(store, session.id, Uint8Array.of(sequence + 1));
  }

  const stored = await record(store, session.id);
  assert.deepEqual(stored.segments.map((unit) => unit.chunks), [[0, 1, 2, 3, 4, 5, 6]]);
  const audio = await store.read(session.id);
  assert.deepEqual(audio.bytes, Uint8Array.of(1, 2, 3, 4, 5, 6, 7),
    'deleting any chunk read makes this public playback value fail');
  assert.deepEqual(audio.missing, []);

  fs.rmSync(path.join(captureRoot(home), session.id, 'segment-00001.webm'));
  fs.rmSync(path.join(captureRoot(home), session.id, 'segment-00003.webm'));
  const partial = await store.read(session.id);
  assert.deepEqual(partial.bytes, Uint8Array.of(1, 3, 5, 6, 7));
  assert.deepEqual(partial.missing, [1, 3], 'each missing physical sequence is reported, even inside one unit');
});

test('D9 playback includes a valid ledger tail before its first transcription unit is sealed', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });

  await appendDurabilityChunk(store, session.id, Uint8Array.of(1, 2));
  await appendDurabilityChunk(store, session.id, Uint8Array.of(3, 4));

  const stored = await record(store, session.id);
  assert.deepEqual(stored.segments, [], 'six seconds is a valid open unit tail');
  assert.deepEqual(stored.chunks?.map((chunk) => chunk.sequence), [0, 1]);
  const audio = await store.read(session.id);
  assert.deepEqual(audio.bytes, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(audio.missing, []);
});

test('D9 playback includes a bytes-first physical tail the record has not claimed yet', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });
  await appendDurabilityChunk(store, session.id, Uint8Array.of(1, 2));
  const storedBefore = await record(store, session.id);
  assert.deepEqual(storedBefore.segments, []);
  assert.deepEqual(storedBefore.chunks?.map((chunk) => chunk.sequence), [0]);

  // The process may die in this exact window: bytes closed on disk, record
  // update not yet written. Playback must not require reconciliation to see it.
  await store.writeSegment(session.id, 1, Uint8Array.of(3, 4));
  const audio = await store.read(session.id);
  assert.deepEqual(audio.bytes, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(audio.missing, []);
});

test('D9 playback preserves post-hole physical audio and states the missing sequence', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null } });

  // Neither file has reached the ledger yet. A kill can leave bytes in this
  // state, including a later write after an earlier file was lost. Playback
  // must use the physical sequence as evidence without pretending the hole is
  // continuous audio.
  await store.writeSegment(session.id, 0, Uint8Array.of(1, 2));
  await store.writeSegment(session.id, 2, Uint8Array.of(5, 6));

  const audio = await store.read(session.id);
  assert.deepEqual(audio.bytes, Uint8Array.of(1, 2, 5, 6));
  assert.deepEqual(audio.missing, [1]);
});

test('a chunk sequence can only ever be written once', async () => {
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
  // chunk file in a directory with no record is the orphan the boot pass
  // deletes, so writing one would be writing audio already destined for the bin.
  await store.discard(session.id);
  await assert.rejects(() => store.writeSegment(session.id, 1, new Uint8Array([3])), /no longer on this device/);
  assert.equal(fs.existsSync(path.join(captureRoot(home), session.id)), false);
});

test('a lease an older build wrote is read off the record and dropped', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, title: 'Recorded by an older build' });
  await append(store, session.id, new Uint8Array([1, 2, 3]), 20_000);
  // A record as the previous shape left it: a heartbeat stamped a moment ago by
  // a window that no longer exists. Against the REAL clock rather than a frozen
  // instant, because that is the case the field was dangerous in — a build that
  // read it would take its own `now` from the wall clock, and a stamp from 2026
  // would look ancient to it and let the reintroduction pass.
  const file = path.join(captureRoot(home), session.id, 'session.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: Record<string, unknown> };
  stored.session.writer = { holderId: 'wr-a-window-that-is-gone', heartbeatAt: new Date(Date.now() - 1_000).toISOString(), epoch: 1 };
  // Also: the capture was left `stopped` by a clean quit, so the boot pass finds
  // nothing to correct and never rewrites it. That is the case
  // `recoverCaptureSession`'s own drop cannot reach, and the one where the dead
  // name used to ride every later `{...session}` back onto the disk.
  stored.session.status = 'stopped';
  stored.session.stoppedAt = new Date(Date.now() - 2_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stored));

  const next = new MeetingCaptureStore(home);
  const read = await record(next, session.id);
  assert.equal('writer' in read, false, 'the record came back without the retired field');
  // …and one ordinary write takes it off the disk for good, rather than leaving
  // the name of a window that no longer exists on this device for ever.
  await next.persist(read);
  const rewritten = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: Record<string, unknown> };
  assert.equal('writer' in rewritten.session, false);
  // The meeting itself is untouched by any of that: it has audio and no terminal
  // state, so it is offered back — at once, with nothing to wait out.
  assert.deepEqual((await next.resumable()).map((offer) => offer.sessionId), [session.id]);
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
  // chunk's SEQUENCE is how the queue reads audio back, so bridging a hole
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
  assert.ok(fs.existsSync(path.join(directory, 'segment-00002.webm')), 'an empty file is unclaimed, not deletion authority');
  assert.ok(fs.existsSync(path.join(directory, 'segment-00003.webm')), 'audio past the hole is preserved for repair');

  // The rewritten record is valid on the next launch, so a one-boot-only guard
  // would forget why sequence 3 was kept and delete it here. Preservation is the
  // recovery policy itself, not a transient property of the first parse.
  const later = new MeetingCaptureStore(home);
  await later.recoverInterrupted();
  assert.ok(fs.existsSync(path.join(directory, 'segment-00002.webm')));
  assert.ok(fs.existsSync(path.join(directory, 'segment-00003.webm')), 'later bytes survive a second boot too');
});

test('malformed D9 references are salvaged from physical chunks, never trusted as authority to delete audio', async (t) => {
  const cases: ReadonlyArray<readonly [string, (unit: Record<string, unknown>) => void]> = [
    ['reordered', (unit) => { unit.chunks = [1, 0, 2, 3, 4, 5, 6]; }],
    ['duplicate', (unit) => { unit.chunks = [0, 1, 1, 3, 4, 5, 6]; }],
    ['out-of-ledger', (unit) => { unit.chunks = [0, 1, 2, 3, 4, 5, 6, 7]; }],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async () => {
      const home = userData();
      const first = new MeetingCaptureStore(home);
      const session = await first.begin({ scope: { orgId: null }, title: `Corrupt ${name}` });
      for (let sequence = 0; sequence < 7; sequence += 1) {
        await appendDurabilityChunk(first, session.id, Uint8Array.of(sequence + 1));
      }
      const directory = path.join(captureRoot(home), session.id);
      const manifest = path.join(directory, 'session.json');
      const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        session: Record<string, unknown> & { segments: Array<Record<string, unknown>> };
      };
      corrupt(raw.session.segments[0]!);
      // A malformed record's terminal word is not trusted. If validation were
      // bypassed, this status would make recovery delete all seven real files.
      raw.session.status = 'finalized';
      raw.session.stoppedAt = '2026-08-11T00:01:00.000Z';
      raw.session.closedAt = '2026-08-11T00:01:00.000Z';
      fs.writeFileSync(manifest, JSON.stringify(raw));

      const recoveredStore = new MeetingCaptureStore(home);
      const report = await recoveredStore.recoverInterrupted();
      assert.deepEqual(report.reaped, [], 'malformed references are not deletion authority');
      assert.deepEqual(report.adopted, [session.id]);
      assert.deepEqual(report.recovered, [session.id]);
      for (let sequence = 0; sequence < 7; sequence += 1) {
        assert.ok(fs.existsSync(path.join(directory, `segment-${String(sequence).padStart(5, '0')}.webm`)));
      }
      const repaired = await record(recoveredStore, session.id);
      assert.equal(isMeetingCaptureSession(repaired), true);
      assert.equal(repaired.status, 'stopped');
      assert.deepEqual(repaired.chunks?.map((chunk) => [chunk.sequence, chunk.startMs, chunk.endMs]), [
        [0, 0, 3_000], [1, 3_000, 6_000], [2, 6_000, 9_000], [3, 9_000, 12_000],
        [4, 12_000, 15_000], [5, 15_000, 18_000], [6, 18_000, 21_000],
      ], 'presence of the raw D9 ledger preserves the short durability cadence');
      assert.deepEqual(repaired.segments.map((unit) => unit.chunks), [[0, 1, 2, 3, 4, 5, 6]]);
      assert.deepEqual((await recoveredStore.read(session.id)).bytes, Uint8Array.of(1, 2, 3, 4, 5, 6, 7));

      const supervisor = new MeetingTranscriptionSupervisor(recoveredStore, {
        transcribe: async () => `recovered-${name}`,
      });
      await supervisor.adopt(session.id);
      await supervisor.settle(session.id);
      assert.equal((await record(recoveredStore, session.id)).segments[0]?.text, `recovered-${name}`,
        'salvaged physical audio is offered back to transcription');
    });
  }
});

test('a terminal word without its lifecycle timestamps cannot authorize audio deletion', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: null }, title: 'Interrupted discard marker' });
  await appendDurabilityChunk(first, session.id, Uint8Array.of(1, 2, 3));
  const directory = path.join(captureRoot(home), session.id);
  const manifest = path.join(directory, 'session.json');
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { session: Record<string, unknown> };
  raw.session.status = 'discarded';
  raw.session.closedAt = '2026-08-11T00:01:00.000Z';
  delete raw.session.stoppedAt;
  fs.writeFileSync(manifest, JSON.stringify(raw));

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted();
  assert.deepEqual(report.reaped, [], 'a malformed terminal marker is not deletion authority');
  assert.deepEqual(report.adopted, [session.id]);
  assert.deepEqual(report.recovered, [session.id]);
  assert.ok(fs.existsSync(path.join(directory, 'segment-00000.webm')));

  const repaired = await record(next, session.id);
  assert.equal(isMeetingCaptureSession(repaired), true);
  assert.equal(repaired.status, 'stopped', 'recovery replaces the malformed terminal record with a safe state');
  assert.deepEqual((await next.read(session.id)).bytes, Uint8Array.of(1, 2, 3));
});

test('a corrupt manifest with a sequence hole preserves later audio after the repaired record and a second boot', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: null }, title: 'Corrupt hole' });
  await first.writeSegment(session.id, 0, Uint8Array.of(1));
  await first.writeSegment(session.id, 2, Uint8Array.of(3));
  const directory = path.join(captureRoot(home), session.id);
  const manifest = path.join(directory, 'session.json');
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { session: Record<string, unknown> };
  raw.session.status = 'finalized';
  raw.session.closedAt = '2026-08-11T00:01:00.000Z';
  raw.session.segments = [{ index: 0, chunks: [2, 2] }];
  fs.writeFileSync(manifest, JSON.stringify(raw));

  const firstBoot = new MeetingCaptureStore(home);
  const firstReport = await firstBoot.recoverInterrupted();
  assert.deepEqual(firstReport.adopted, [session.id]);
  assert.deepEqual(firstReport.reaped, []);
  assert.ok(fs.existsSync(path.join(directory, 'segment-00002.webm')), 'repair keeps bytes beyond missing sequence 1');
  assert.equal(isMeetingCaptureSession(await record(firstBoot, session.id)), true, 'the rewritten manifest is valid');
  const firstAudio = await firstBoot.read(session.id);
  assert.deepEqual(firstAudio.bytes, Uint8Array.of(1, 3), 'the first repair still exposes bytes beyond the hole');
  assert.deepEqual(firstAudio.missing, [1], 'the first repair reports the hole instead of closing it in playback');

  const secondBoot = new MeetingCaptureStore(home);
  const secondReport = await secondBoot.recoverInterrupted();
  assert.deepEqual(secondReport.reaped, []);
  assert.ok(fs.existsSync(path.join(directory, 'segment-00002.webm')),
    'a later boot must not treat the now-valid rewritten manifest as permission to delete the tail');
  const secondAudio = await secondBoot.read(session.id);
  assert.deepEqual(secondAudio.bytes, Uint8Array.of(1, 3), 'later boots keep post-hole audio playable');
  assert.deepEqual(secondAudio.missing, [1], 'later boots keep reporting the same physical hole');
});

test('salvage preserves an absent legacy ledger and credits its physical file at the legacy cadence', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: null }, title: 'Legacy corrupt record' });
  await first.writeSegment(session.id, 0, Uint8Array.of(1, 2, 3));
  const directory = path.join(captureRoot(home), session.id);
  const manifest = path.join(directory, 'session.json');
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { session: Record<string, unknown> };
  delete raw.session.chunks;
  raw.session.segments = [{ index: 7, chunks: [7, 7] }];
  fs.writeFileSync(manifest, JSON.stringify(raw));

  const recoveredStore = new MeetingCaptureStore(home);
  await recoveredStore.recoverInterrupted();
  const repaired = await record(recoveredStore, session.id);

  assert.equal(isMeetingCaptureSession(repaired), true);
  assert.deepEqual(repaired.chunks?.map((chunk) => [chunk.sequence, chunk.startMs, chunk.endMs]), [[0, 0, 20_000]],
    'absence, rather than contents, of the raw ledger identifies legacy file duration');
  assert.ok(fs.existsSync(path.join(directory, 'segment-00000.webm')));
});

test('a mismatched raw session id contributes no tenant metadata to the salvaged directory', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: null }, title: 'Directory owner' });
  await first.writeSegment(session.id, 0, Uint8Array.of(1, 2, 3));
  const manifest = path.join(captureRoot(home), session.id, 'session.json');
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { session: Record<string, unknown> };
  raw.session.id = 'mtg-another-tenant-record';
  raw.session.scope = { orgId: 'org-other', workspaceId: 'workspace-other' };
  raw.session.title = 'Other tenant meeting';
  raw.session.language = 'fr';
  fs.writeFileSync(manifest, JSON.stringify(raw));

  const recoveredStore = new MeetingCaptureStore(home);
  await recoveredStore.recoverInterrupted();
  const recovered = await record(recoveredStore, session.id);

  assert.equal(recovered.id, session.id);
  assert.deepEqual(recovered.scope, { orgId: null, workspaceId: null });
  assert.equal(recovered.title, 'Recovered meeting');
  assert.equal(recovered.language, undefined);
  assert.equal(fs.statSync(path.join(captureRoot(home), session.id, 'segment-00000.webm')).size, 3);
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

test('one unreadable saved chunk costs that chunk, not the whole recording', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const session = await store.begin({ scope: { orgId: null }, contentType: 'audio/webm;codecs=opus' });
  await append(store, session.id, new Uint8Array([1, 2]), 20_000);
  await append(store, session.id, new Uint8Array([3, 4]), 20_000);
  await append(store, session.id, new Uint8Array([5, 6]), 20_000);

  // The record still claims three saved chunks — this is exactly the state §6 is
  // about, where the recovery card advertises a byte count for audio one file
  // of which the disk will not give back.
  fs.rmSync(path.join(captureRoot(home), session.id, 'segment-00001.webm'));

  const audio = await store.read(session.id);
  // Before the per-chunk guard this call REJECTED, and the surface showed the
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
  const closedAt = new Date().toISOString();
  stored.session.status = 'discarded';
  stored.session.stoppedAt = closedAt;
  stored.session.closedAt = closedAt;
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

test('malformed top-level record JSON quarantines physical audio across two boots and every tenant scope', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: 'org-source' }, title: 'Unreadable metadata' });
  await first.writeSegment(session.id, 0, Uint8Array.of(1, 2, 3));
  const directory = path.join(captureRoot(home), session.id);
  const manifest = path.join(directory, 'session.json');
  fs.writeFileSync(manifest, '{"version":1,"session":');

  for (let boot = 1; boot <= 2; boot += 1) {
    const store = new MeetingCaptureStore(home);
    const report = await store.recoverInterrupted();
    assert.deepEqual(report, { recovered: [], adopted: [], reaped: [] }, `boot ${boot} quarantines rather than inventing a session`);
    assert.ok(fs.existsSync(path.join(directory, 'segment-00000.webm')), `boot ${boot} preserves the physical audio`);
    assert.equal(fs.readFileSync(manifest, 'utf8'), '{"version":1,"session":', 'the corrupt evidence is not rewritten from guesses');
    assert.deepEqual(await store.resumable({ orgId: 'org-source' }), []);
    assert.deepEqual(await store.resumable({ orgId: 'org-other' }), []);
    assert.deepEqual(await store.resumable({ orgId: null }), []);
  }
});

test('an existing record path that cannot be read is quarantined across two boots', async () => {
  const home = userData();
  const first = new MeetingCaptureStore(home);
  const session = await first.begin({ scope: { orgId: 'org-source' }, title: 'Unreadable file' });
  await first.writeSegment(session.id, 0, Uint8Array.of(4, 5, 6));
  const directory = path.join(captureRoot(home), session.id);
  const manifest = path.join(directory, 'session.json');
  fs.rmSync(manifest);
  fs.mkdirSync(manifest);

  for (let boot = 1; boot <= 2; boot += 1) {
    const store = new MeetingCaptureStore(home);
    const report = await store.recoverInterrupted();
    assert.deepEqual(report.reaped, [], `boot ${boot} distinguishes an unreadable existing path from no record`);
    assert.ok(fs.statSync(manifest).isDirectory());
    assert.deepEqual(fs.readFileSync(path.join(directory, 'segment-00000.webm')), Buffer.from([4, 5, 6]));
    assert.deepEqual(await store.resumable({ orgId: 'org-source' }), [], 'no tenant offer is inferred without metadata');
  }
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

  assert.deepEqual(report.reaped, ['mtg-orphaned-capture'], 'a truly absent record remains D6 orphan authority');
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(fs.existsSync(path.join(captureRoot(home), live.id)));
});

test('a capture id that is not path-safe is refused before it becomes a path', async () => {
  const store = new MeetingCaptureStore(userData());
  await assert.rejects(() => store.stored('../../etc'), /not a meeting capture id/);
  await assert.rejects(() => append(store, '..', new Uint8Array([1]), 20_000), /not a meeting capture id/);
});

/**
 * D6 — liveness is not this store's to know, and the boot pass has to be TOLD.
 *
 * The question "is a window recording into this capture?" is the process's, and
 * the process answers it exactly (`meetingTranscription.ts`). What is left here
 * is the one pass that runs with no window involved at all, and the one that can
 * destroy a live meeting three different ways if it is wrong about this.
 */
test('the boot pass leaves a capture that is being recorded into exactly as it found it', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const live = await store.begin({ scope: { orgId: null }, title: 'Live' });
  await append(store, live.id, new Uint8Array([1, 2, 3]), 20_000);
  // A chunk the record has not claimed yet, which is what an in-flight recording
  // looks like from outside for the moment between the bytes and the record.
  const directory = path.join(captureRoot(home), live.id);
  fs.writeFileSync(path.join(directory, 'segment-00001.webm'), Buffer.from([4, 5]));
  // …and a Record pressed a moment ago, from a previous process's point of view:
  // no chunk yet, and older than the store now running this pass.
  const arming = await store.begin({ scope: { orgId: null }, title: 'Just pressed Record' });
  await store.persist({ ...arming, startedAt: '2020-01-01T00:00:00.000Z' });

  const next = new MeetingCaptureStore(home);
  const report = await next.recoverInterrupted({ isWriting: (id) => id === live.id || id === arming.id });

  // All three destructive halves of the pass, not one: guarding only the reap
  // left the record rewrite and the chunk adoption to run over a live capture,
  // and the adoption is the one that ends the meeting — the recorder's own
  // chunk ledger cannot advance past a collision, so every later chunk failed
  // `EEXIST` for ever with no self-heal.
  assert.deepEqual(report, { recovered: [], adopted: [], reaped: [] });
  const untouched = await record(next, live.id);
  assert.equal(untouched.status, 'recording');
  assert.deepEqual(untouched.segments.map((segment) => segment.index), [0]);
  assert.ok(fs.existsSync(path.join(directory, 'segment-00001.webm')));
  assert.ok(fs.existsSync(path.join(captureRoot(home), arming.id)));

  // The same two captures with nobody recording are exactly what this pass is
  // for, so the guard cannot be "never correct anything".
  const corrected = await new MeetingCaptureStore(home).recoverInterrupted();
  assert.deepEqual(corrected.recovered, [live.id]);
  assert.deepEqual(corrected.adopted, [live.id]);
  assert.deepEqual(corrected.reaped, [arming.id]);
  assert.equal((await record(next, live.id)).status, 'stopped');
});
