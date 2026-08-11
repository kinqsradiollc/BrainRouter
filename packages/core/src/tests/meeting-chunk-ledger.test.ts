/**
 * ADR-035 D9 — durability chunks are not transcription units.
 *
 * These are behavioral guards over the persisted record, not source-shape
 * checks. A recorder may write several short chunks without creating any unit;
 * only the strategy seals them. Stop and recovery must then claim the short
 * tail, because bytes present in the ledger but absent from every unit are audio
 * no queue can transcribe.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendChunk,
  appendSegment,
  captureChunks,
  capturedByteLength,
  createCaptureSession,
  DEFAULT_MEETING_CHUNK_MS,
  DEFAULT_MEETING_UNIT_MS,
  isResumableSession,
  openChunks,
  recoverCaptureSession,
  sealDueUnits,
  sealUnit,
  stopCapture,
  summarizeRecovery,
  unitChunkSequences,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE = { orgId: null, workspaceId: null } as const;

function recording(id = 'mtg-d9'): MeetingCaptureSession {
  return createCaptureSession({
    id,
    scope: SCOPE,
    startedAt: '2026-08-11T09:00:00.000Z',
  });
}

function appendDurabilityChunks(session: MeetingCaptureSession, count: number): MeetingCaptureSession {
  let next = session;
  for (let index = 0; index < count; index += 1) {
    next = appendChunk(next, { byteLength: 100 + index, durationMs: DEFAULT_MEETING_CHUNK_MS });
  }
  return next;
}

test('D9 — short durability writes stay separate from a longer transcription unit', () => {
  assert.ok(DEFAULT_MEETING_CHUNK_MS < DEFAULT_MEETING_UNIT_MS);
  let session = recording();
  assert.deepEqual(session.chunks, [], 'a new record identifies the D9 ledger even before its first write');

  for (let index = 0; index < 6; index += 1) {
    session = appendChunk(session, { byteLength: 100 + index, durationMs: DEFAULT_MEETING_CHUNK_MS });
    session = sealDueUnits(session);
  }

  assert.equal(session.chunks!.length, 6, 'six writes are already durable');
  assert.equal(session.segments.length, 0, 'eighteen seconds is still an open transcription unit');
  assert.equal(capturedByteLength(session), 615, 'recovery counts open bytes, not only sealed units');
  assert.ok(isResumableSession(session), 'a kill before the first unit still offers the meeting back');

  session = appendChunk(session, { byteLength: 106, durationMs: DEFAULT_MEETING_CHUNK_MS });
  session = sealDueUnits(session);
  assert.equal(session.segments.length, 1);
  assert.deepEqual(unitChunkSequences(session.segments[0]!), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(session.segments[0]!.byteLength, 721);
  assert.deepEqual([session.segments[0]!.startMs, session.segments[0]!.endMs], [0, 21_000]);

  session = appendChunk(session, { byteLength: 107, durationMs: DEFAULT_MEETING_CHUNK_MS });
  session = sealDueUnits(session);
  assert.equal(session.segments.length, 1, 'the next short write does not become a unit of its own');
  assert.deepEqual(openChunks(session).map((chunk) => chunk.sequence), [7]);
});

test('D9 — an endpoint boundary seals only the covered chunk prefix', () => {
  const written = appendDurabilityChunks(recording('mtg-boundary'), 3);
  const first = sealUnit(written, { throughSequence: 1 });
  assert.deepEqual(unitChunkSequences(first.segments[0]!), [0, 1]);
  assert.deepEqual(openChunks(first).map((chunk) => chunk.sequence), [2]);

  const complete = sealUnit(first);
  assert.deepEqual(complete.segments.map(unitChunkSequences), [[0, 1], [2]]);
  assert.equal(sealUnit(complete), complete, 'a chunk is never claimed by a second unit');
});

test('D9 — an endpoint boundary cannot grow one upload past the hard duration ceiling', () => {
  const written = appendDurabilityChunks(recording('mtg-bounded-boundary'), 16);
  const sealed = sealUnit(written, { throughSequence: 15 });

  assert.equal(sealed.segments.length, 2, 'a 48-second covered run is split before upload');
  assert.deepEqual(unitChunkSequences(sealed.segments[0]!), Array.from({ length: 15 }, (_, index) => index));
  assert.deepEqual(unitChunkSequences(sealed.segments[1]!), [15]);
  assert.ok(sealed.segments.every((segment) => segment.endMs - segment.startMs <= 45_000));
});

test('D9 — the byte ceiling splits a boundary before it can recreate a whole-meeting request', () => {
  const written = appendDurabilityChunks(recording('mtg-byte-ceiling'), 3);
  const sealed = sealUnit(written, {
    throughSequence: 2,
    policy: { targetMs: 60_000, maxMs: 60_000, maxBytes: 250 },
  });

  assert.deepEqual(sealed.segments.map((segment) => segment.byteLength), [201, 102]);
  assert.deepEqual(sealed.segments.map(unitChunkSequences), [[0, 1], [2]]);
  assert.ok(sealed.segments.every((segment) => segment.byteLength <= 250));
});

test('D9 — stopping seals a short tail so every written byte becomes queue work', () => {
  const written = appendDurabilityChunks(recording('mtg-stop-tail'), 2);
  assert.equal(written.segments.length, 0);

  const stopped = stopCapture(written, '2026-08-11T09:00:06.000Z');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.segments.length, 1);
  assert.deepEqual(unitChunkSequences(stopped.segments[0]!), [0, 1]);
  assert.equal(stopped.segments[0]!.byteLength, 201);
  assert.deepEqual(openChunks(stopped), []);
});

test('D9 — recovery seals the chunks written before a kill and reports their full duration', () => {
  const killed = appendDurabilityChunks(recording('mtg-killed-tail'), 2);
  const before = summarizeRecovery(killed);
  assert.deepEqual(
    { durationMs: before.durationMs, byteLength: before.byteLength, segments: before.segments },
    { durationMs: 6_000, byteLength: 201, segments: 0 },
  );

  const recovered = recoverCaptureSession(killed, '2026-08-11T10:00:00.000Z');
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.segments.length, 1, 'the tail is work after the writer dies');
  assert.deepEqual(unitChunkSequences(recovered.segments[0]!), [0, 1]);
  assert.equal(recovered.segments[0]!.state, 'pending');
  assert.equal(capturedByteLength(recovered), 201);
});

test('D9 — records without a ledger keep the legacy one-segment/one-chunk meaning', () => {
  const legacy: MeetingCaptureSession = {
    id: 'mtg-legacy',
    startedAt: '2026-08-10T09:00:00.000Z',
    scope: SCOPE,
    title: 'Legacy capture',
    template: 'general',
    status: 'recording',
    segments: [{
      index: 0,
      byteLength: 400,
      startMs: 0,
      endMs: 20_000,
      state: 'done',
      text: 'legacy text',
      attempts: 1,
    }],
  };

  assert.equal(legacy.chunks, undefined);
  assert.deepEqual(captureChunks(legacy), [{ sequence: 0, byteLength: 400, startMs: 0, endMs: 20_000 }]);
  assert.deepEqual(unitChunkSequences(legacy.segments[0]!), [0]);

  const grown = appendChunk(legacy, { byteLength: 50, durationMs: DEFAULT_MEETING_CHUNK_MS });
  assert.deepEqual(grown.chunks!.map((chunk) => chunk.sequence), [0, 1]);
  const stopped = stopCapture(grown);
  assert.equal(stopped.segments.length, 2);
  assert.deepEqual(stopped.segments.map(unitChunkSequences), [[0], [1]]);
  assert.equal(stopped.segments[0]!.text, 'legacy text');
});

test('appendSegment remains a one-file compatibility path with an explicit chunk mapping', () => {
  const session = appendSegment(recording('mtg-import'), { byteLength: 2_048, durationMs: 12_000 });
  assert.deepEqual(session.chunks, [{ sequence: 0, byteLength: 2_048, startMs: 0, endMs: 12_000 }]);
  assert.deepEqual(unitChunkSequences(session.segments[0]!), [0]);
});
