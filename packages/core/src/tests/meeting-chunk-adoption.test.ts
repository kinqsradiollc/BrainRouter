/**
 * ADR-035 D1/D2/D9 — the record catches up with the bytes.
 *
 * D1 writes the audio and THEN the record, so a kill leaves stored chunks the
 * session never claimed. §6 asks for "the audio up to the kill", which means the
 * chunk at the end must be believed rather than deleted to match a stale record.
 *
 * The negative assertions are the ones that matter: nothing bridges a hole,
 * and a terminal meeting adopts nothing at all. Legacy records still map one
 * stored chunk to one segment; D9 records adopt into the ledger and then group
 * the recovered chunks into transcription units.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adoptCaptureChunks,
  DEFAULT_MEETING_CHUNK_MS,
  appendSegment,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  stopCapture,
  unitChunkSequences,
  type MeetingCaptureSession,
} from '../meetings/index.js';

const SCOPE = { orgId: null, workspaceId: null } as const;

function recording(segments = 0): MeetingCaptureSession {
  const created = createCaptureSession({
    id: 'mtg-adopt',
    scope: SCOPE,
    title: 'Weekly sync',
    startedAt: '2026-08-09T10:00:00.000Z',
  });
  // No ledger is the persisted pre-D9 shape. Keeping these fixtures explicit
  // guards the compatibility path instead of accidentally testing new records.
  const { chunks: _d9Ledger, ...legacy } = created;
  let session: MeetingCaptureSession = legacy;
  for (let index = 0; index < segments; index += 1) {
    session = appendSegment(session, { byteLength: 1024, durationMs: 20_000 });
  }
  return session;
}

test('a legacy chunk the record never claimed keeps its one-segment meaning', () => {
  const result = adoptCaptureChunks(recording(1), [
    { sequence: 0, byteLength: 1024 },
    { sequence: 1, byteLength: 2048 },
  ]);

  assert.deepEqual(result.adopted, [1]);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.session.segments.length, 2);
  assert.equal(result.session.segments[1]!.byteLength, 2048);
  assert.equal(result.session.segments[1]!.state, 'pending');
  // The range continues the recorder's cadence rather than restarting the clock.
  assert.equal(result.session.segments[1]!.startMs, 20_000);
  assert.equal(result.session.segments[1]!.endMs, 40_000);
});

test('adoption stops at a hole, and everything past it is reported rather than believed', () => {
  const result = adoptCaptureChunks(recording(1), [
    { sequence: 1, byteLength: 2048 },
    { sequence: 3, byteLength: 4096 },
    { sequence: 4, byteLength: 4096 },
  ]);

  assert.deepEqual(result.adopted, [1], 'chunk 2 is missing, so 3 and 4 read as somebody else\'s audio');
  assert.deepEqual(result.rejected, [3, 4]);
  assert.equal(result.session.segments.length, 2);
});

test('a zero-byte chunk is a hole, not a segment', () => {
  const session = recording(0);
  const result = adoptCaptureChunks(session, [
    { sequence: 0, byteLength: 0 },
    { sequence: 1, byteLength: 4096 },
  ]);

  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.rejected, [0, 1]);
  assert.equal(result.session, session, 'the session is handed back untouched');
});

test('a cleanly stopped capture is resumed for the append and stopped again at its ORIGINAL instant', () => {
  const stopped = stopCapture(recording(1), '2026-08-09T10:00:30.000Z');
  const result = adoptCaptureChunks(stopped, [{ sequence: 1, byteLength: 2048 }]);

  assert.equal(result.session.status, 'stopped');
  assert.equal(result.session.stoppedAt, '2026-08-09T10:00:30.000Z', 'the recording did not restart');
  assert.equal(result.session.segments.length, 2);
});

test('a recording capture stays recording', () => {
  const result = adoptCaptureChunks(recording(0), [{ sequence: 0, byteLength: 512 }]);
  assert.equal(result.session.status, 'recording');
  assert.equal(result.session.stoppedAt, undefined);
});

test('D6 — a finalized or discarded meeting adopts nothing, and claims nothing for the reap either', () => {
  for (const closed of [finalizeCapture(recording(1)), discardCapture(recording(1))]) {
    const result = adoptCaptureChunks(closed, [{ sequence: 1, byteLength: 2048 }]);
    assert.equal(result.session, closed, 'its audio was released; there is nothing to claim');
    assert.deepEqual(result.adopted, []);
    assert.deepEqual(result.rejected, [], 'deleting a closed meeting\'s bytes is the reap\'s decision');
  }
});

test('chunks the record already describes are not adopted twice', () => {
  const result = adoptCaptureChunks(recording(2), [
    { sequence: 0, byteLength: 1024 },
    { sequence: 1, byteLength: 1024 },
  ]);
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.session.segments.length, 2);
});

test('order in the listing does not matter; sequence does', () => {
  const result = adoptCaptureChunks(recording(0), [
    { sequence: 2, byteLength: 3 },
    { sequence: 0, byteLength: 1 },
    { sequence: 1, byteLength: 2 },
  ]);
  assert.deepEqual(result.adopted, [0, 1, 2]);
  assert.deepEqual(result.session.segments.map((segment) => segment.byteLength), [1, 2, 3]);
});

test('D9 — adopted durability chunks are grouped into a transcription unit, not seven tiny uploads', () => {
  const session = createCaptureSession({
    id: 'mtg-adopt-d9',
    scope: SCOPE,
    startedAt: '2026-08-11T10:00:00.000Z',
  });
  const chunks = Array.from({ length: 7 }, (_, sequence) => ({ sequence, byteLength: 100 + sequence }));
  const result = adoptCaptureChunks(session, chunks, { chunkMs: DEFAULT_MEETING_CHUNK_MS });

  assert.deepEqual(result.adopted, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.session.chunks!.length, 7);
  assert.equal(result.session.segments.length, 1, 'adoption preserves the chunk/unit split');
  assert.deepEqual(unitChunkSequences(result.session.segments[0]!), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.session.segments[0]!.byteLength, 721);
  assert.equal(result.session.segments[0]!.endMs, 21_000);
});

test('a non-integer or negative sequence is not a chunk this rule will believe', () => {
  const result = adoptCaptureChunks(recording(0), [
    { sequence: 0.5, byteLength: 1024 },
    { sequence: -1, byteLength: 1024 },
  ]);
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.session.segments.length, 0);
});

test('the deprecated segmentMs option still credits an unclaimed legacy chunk correctly', () => {
  const result = adoptCaptureChunks(recording(0), [{ sequence: 0, byteLength: 900 }], { segmentMs: 30_000 });
  assert.equal(result.session.segments[0]!.endMs, 30_000);
});

test('an empty listing leaves the session identical', () => {
  const session = recording(2);
  const result = adoptCaptureChunks(session, []);
  assert.equal(result.session, session);
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.rejected, []);
});
