/**
 * ADR-035 D9 — a capture manifest is accepted only when its durability ledger
 * and transcription units describe the same audio, in the same order.
 *
 * These are behavioral guards for the persisted compatibility boundary, not a
 * schema snapshot. Every corrupt fixture changes one relational fact while the
 * rest stays valid, so removing the corresponding validator line must make a
 * named assertion fail. Legacy sessions, mixed migrated sessions and a current
 * ledger with an open tail are all valid on purpose.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discardCapture,
  finalizeCapture,
  isMeetingCaptureSession,
  stopCapture,
  type MeetingCaptureSession,
  type MeetingChunk,
  type MeetingSegment,
} from '../meetings/index.js';

function chunk(sequence: number, byteLength = 10, startMs = sequence * 3_000): MeetingChunk {
  return { sequence, byteLength, startMs, endMs: startMs + 3_000 };
}

function segment(
  index: number,
  chunks: readonly number[] | undefined,
  byteLength: number,
  startMs: number,
  endMs: number,
): MeetingSegment {
  return {
    index,
    byteLength,
    startMs,
    endMs,
    ...(chunks === undefined ? {} : { chunks }),
    state: 'pending',
    attempts: 0,
  };
}

function session(overrides: Partial<MeetingCaptureSession> = {}): MeetingCaptureSession {
  return {
    id: 'mtg-validation',
    startedAt: '2026-08-11T00:00:00.000Z',
    scope: { orgId: 'org-one', workspaceId: null },
    title: 'Validation fixture',
    template: 'general',
    status: 'recording',
    segments: [],
    chunks: [],
    ...overrides,
  };
}

function currentTwoChunkUnit(): MeetingCaptureSession {
  return session({
    chunks: [chunk(0, 10), chunk(1, 20)],
    segments: [segment(0, [0, 1], 30, 0, 6_000)],
  });
}

test('D2/D6 validation — lifecycle statuses carry the timestamps their real transitions write', () => {
  const recording = session();
  const stopped = stopCapture(recording, '2026-08-11T00:10:00.000Z');
  const finalized = finalizeCapture(recording, '2026-08-11T00:20:00.000Z');
  const discarded = discardCapture(recording, '2026-08-11T00:30:00.000Z');

  for (const valid of [recording, stopped, finalized, discarded]) {
    assert.equal(isMeetingCaptureSession(valid), true, `${valid.status} transition output must remain readable`);
  }

  const { chunks: _ledger, ...legacyRecording } = recording;
  for (const validLegacy of [
    legacyRecording,
    stopCapture(legacyRecording, '2026-08-11T00:10:00.000Z'),
    finalizeCapture(legacyRecording, '2026-08-11T00:20:00.000Z'),
    discardCapture(legacyRecording, '2026-08-11T00:30:00.000Z'),
  ]) {
    assert.equal(isMeetingCaptureSession(validLegacy), true, `legacy ${validLegacy.status} must remain readable`);
  }
});

test('D6 validation — changing only a live status cannot forge deletion authority', () => {
  const live = currentTwoChunkUnit();
  assert.equal(live.stoppedAt, undefined);
  assert.equal(live.closedAt, undefined);
  assert.equal(isMeetingCaptureSession({ ...live, status: 'finalized' }), false,
    'a lone finalized word must fall into host salvage, not audio deletion');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'discarded' }), false,
    'a lone discarded word must fall into host salvage, not audio deletion');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'stopped' }), false,
    'a stopped record must carry the stop transition timestamp');
});

test('D6 validation — every lifecycle accepts exactly its persisted timestamp shape', () => {
  const live = currentTwoChunkUnit();
  const stoppedAt = '2026-08-11T00:10:00.000Z';
  const closedAt = '2026-08-11T00:20:00.000Z';

  assert.equal(isMeetingCaptureSession({ ...live, stoppedAt }), false, 'recording cannot retain a stale stop stamp');
  assert.equal(isMeetingCaptureSession({ ...live, closedAt }), false, 'recording cannot carry a terminal stamp');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'stopped', stoppedAt, closedAt }), false,
    'stopped is non-terminal and cannot authorize a close');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'finalized', closedAt }), false,
    'terminal records require the stop stamp their transition writes too');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'discarded', stoppedAt }), false,
    'terminal records require a close stamp');
  assert.equal(isMeetingCaptureSession({ ...live, status: 'discarded', stoppedAt: 'not-a-time', closedAt }), false,
    'malformed text is not a persisted timestamp');
});

test('D9 validation — legacy records have no ledger and no per-unit chunk references', () => {
  const validLegacy = session({
    chunks: undefined,
    segments: [segment(0, undefined, 10, 0, 20_000), segment(1, undefined, 20, 20_000, 40_000)],
  });
  assert.equal(isMeetingCaptureSession(validLegacy), true);
  assert.equal(isMeetingCaptureSession({
    ...validLegacy,
    segments: [{ ...validLegacy.segments[0]!, chunks: [0] }, validLegacy.segments[1]!],
  }), false, 'a unit cannot name a chunk without a ledger to resolve it against');
});

test('D9 validation — a migrated legacy prefix may precede explicit current units', () => {
  const mixed = session({
    chunks: [
      { sequence: 0, byteLength: 10, startMs: 0, endMs: 20_000 },
      chunk(1, 20, 20_000),
      chunk(2, 30, 23_000),
    ],
    segments: [
      segment(0, undefined, 10, 0, 20_000),
      segment(1, [1, 2], 50, 20_000, 26_000),
    ],
  });
  assert.equal(isMeetingCaptureSession(mixed), true);
  assert.equal(isMeetingCaptureSession({
    ...mixed,
    segments: [
      { ...mixed.segments[0]!, chunks: [0] },
      segment(1, undefined, 20, 20_000, 23_000),
    ],
  }), false, 'implicit compatibility units are valid only as the migrated prefix');
});

test('D9 validation — current units claim one ascending, gapless ledger prefix', () => {
  const valid = currentTwoChunkUnit();
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, chunks: [1, 0] }],
  }), false, 'reordered chunk references must be rejected');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, chunks: [0, 0] }],
  }), false, 'duplicate chunk references must be rejected');

  const threeChunks = [chunk(0, 10), chunk(1, 20), chunk(2, 30)];
  assert.equal(isMeetingCaptureSession(session({
    chunks: threeChunks,
    segments: [segment(0, [0, 2], 40, 0, 9_000)],
  })), false, 'an in-ledger skip must be rejected even when bytes and outer range agree');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [segment(0, [0, 1, 2], 60, 0, 9_000)],
  }), false, 'an otherwise contiguous reference past the ledger must be rejected');
});

test('D9 validation — unit bytes and ranges must exactly equal their referenced chunks', () => {
  const valid = currentTwoChunkUnit();
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, byteLength: 10 }],
  }), false, 'omitting an interior chunk from the byte total must be visible');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, startMs: 1 }],
  }), false, 'a unit cannot start after its first referenced chunk');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, endMs: 5_999 }],
  }), false, 'a unit cannot end before its last referenced chunk');
});

test('D9 validation — the ledger is positive, contiguous by key and ordered by range', () => {
  const valid = currentTwoChunkUnit();
  assert.equal(isMeetingCaptureSession({
    ...valid,
    chunks: [{ ...valid.chunks![0]!, sequence: 1 }, { ...valid.chunks![1]!, sequence: 0 }],
  }), false, 'reordered keys');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    chunks: [valid.chunks![0]!, { ...valid.chunks![1]!, sequence: 0 }],
  }), false, 'duplicate keys');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    chunks: [{ ...valid.chunks![0]!, byteLength: 0 }, valid.chunks![1]!],
    segments: [{ ...valid.segments[0]!, byteLength: 20 }],
  }), false, 'empty bytes');
  assert.equal(isMeetingCaptureSession({
    ...valid,
    chunks: [valid.chunks![0]!, { ...valid.chunks![1]!, startMs: 1_000, endMs: 4_000 }],
    segments: [{ ...valid.segments[0]!, endMs: 4_000 }],
  }), false, 'overlapping ranges');
});

test('D9 validation — an unclaimed ledger suffix is a valid open unit tail', () => {
  const openTail = session({
    chunks: [chunk(0, 10), chunk(1, 20), chunk(2, 30)],
    segments: [segment(0, [0, 1], 30, 0, 6_000)],
  });
  assert.equal(isMeetingCaptureSession(openTail), true);
});

test('D9 validation — basic session, scope and segment shapes fail closed', () => {
  const valid = currentTwoChunkUnit();
  assert.equal(isMeetingCaptureSession(null), false);
  assert.equal(isMeetingCaptureSession({ ...valid, status: 'paused' }), false);
  assert.equal(isMeetingCaptureSession({ ...valid, scope: { orgId: 4 } }), false);
  assert.equal(isMeetingCaptureSession({ ...valid, template: 'interview' }), false);
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, index: 1 }],
  }), false);
  assert.equal(isMeetingCaptureSession({
    ...valid,
    segments: [{ ...valid.segments[0]!, state: 'queued' }],
  }), false);
});
