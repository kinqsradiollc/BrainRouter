/**
 * ADR-027 D4 (P2-1/P2-2) — attachment dedup, quota, retention, safe deletion.
 *
 * The tests that matter here are the ones about SHARED blobs. Content-addressed
 * storage makes the naive answers wrong in a way that destroys data: deleting a
 * record must not unlink a blob another record still references, and a sweep
 * must not report bytes it did not actually free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planAttachmentIngest,
  planAttachmentDeletion,
  planAttachmentEviction,
} from '../attachment/policy/attachmentPolicy.js';

const rec = (id: string, sha256: string, byteSize = 100, updatedAt = '2026-01-01T00:00:00.000Z') =>
  ({ id, sha256, byteSize, updatedAt });

test('an identical blob is reused rather than copied again', () => {
  const plan = planAttachmentIngest({
    sha256: 'aaa', byteSize: 500, existing: [rec('att_1', 'aaa', 500)],
  });
  assert.deepEqual(plan, { action: 'reuse', existingId: 'att_1', reclaimedBytes: 500 });
});

test('new content is stored', () => {
  const plan = planAttachmentIngest({ sha256: 'bbb', byteSize: 10, existing: [rec('att_1', 'aaa')] });
  assert.deepEqual(plan, { action: 'store' });
});

test('a duplicate is reused even when the workspace is already at quota', () => {
  // Re-attaching a file the workspace already holds costs no new bytes, so
  // refusing it for being "over quota" would be both wrong and baffling.
  const plan = planAttachmentIngest({
    sha256: 'aaa',
    byteSize: 900,
    existing: [rec('att_1', 'aaa', 900)],
    quota: { maxTotalBytes: 1_000 },
  });
  assert.equal(plan.action, 'reuse');
});

test('a file over the per-file limit is rejected with a readable reason', () => {
  const plan = planAttachmentIngest({
    sha256: 'x', byteSize: 5_000_000, existing: [], quota: { maxFileBytes: 1_000_000 },
  });
  assert.equal(plan.action, 'reject');
  assert.match((plan as { reason: string }).reason, /5\.0 MB/);
  assert.match((plan as { reason: string }).reason, /1\.0 MB/);
});

test('quota usage counts each distinct blob once, not each record', () => {
  // Three records sharing one 400-byte blob use 400 bytes, not 1200. Counting
  // per record would reject an ingest the workspace has room for.
  const shared = [rec('a', 'same', 400), rec('b', 'same', 400), rec('c', 'same', 400)];
  const plan = planAttachmentIngest({
    sha256: 'new', byteSize: 500, existing: shared, quota: { maxTotalBytes: 1_000 },
  });
  assert.deepEqual(plan, { action: 'store' });
});

test('an ingest that would exceed the workspace limit is rejected', () => {
  const plan = planAttachmentIngest({
    sha256: 'new', byteSize: 700, existing: [rec('a', 'old', 400)], quota: { maxTotalBytes: 1_000 },
  });
  assert.equal(plan.action, 'reject');
  assert.match((plan as { reason: string }).reason, /workspace limit/);
});

test('a zero or absent quota means unlimited', () => {
  assert.equal(planAttachmentIngest({ sha256: 'n', byteSize: 1e9, existing: [] }).action, 'store');
  assert.equal(
    planAttachmentIngest({ sha256: 'n', byteSize: 1e9, existing: [], quota: { maxTotalBytes: 0, maxFileBytes: 0 } }).action,
    'store',
  );
});

test('deleting a record with a UNIQUE blob unlinks the blob', () => {
  const all = [rec('a', 'aaa'), rec('b', 'bbb')];
  assert.deepEqual(planAttachmentDeletion(rec('a', 'aaa'), all), {
    removeRecord: true, removeBlob: true, stillReferencedBy: [],
  });
});

test('deleting a record with a SHARED blob keeps the blob', () => {
  // The bug this prevents: "delete the record, delete its file" destroys the
  // bytes of every other record sharing that hash.
  const all = [rec('a', 'same'), rec('b', 'same'), rec('c', 'other')];
  assert.deepEqual(planAttachmentDeletion(rec('a', 'same'), all), {
    removeRecord: true, removeBlob: false, stillReferencedBy: ['b'],
  });
});

test('the last record holding a shared blob does unlink it', () => {
  const all = [rec('b', 'same')];
  assert.equal(planAttachmentDeletion(rec('b', 'same'), all).removeBlob, true);
});

test('eviction removes expired records oldest first and leaves fresh ones', () => {
  const now = '2026-06-01T00:00:00.000Z';
  const old1 = rec('old1', 'h1', 100, '2026-01-01T00:00:00.000Z');
  const old2 = rec('old2', 'h2', 200, '2026-02-01T00:00:00.000Z');
  const fresh = rec('fresh', 'h3', 300, '2026-05-30T00:00:00.000Z');

  const plan = planAttachmentEviction({ records: [fresh, old2, old1], now, retentionDays: 90 });
  assert.deepEqual(plan.recordIds, ['old1', 'old2']);
  assert.equal(plan.reclaimedBytes, 300);
});

test('a blob shared with a surviving record is NOT orphaned', () => {
  const now = '2026-06-01T00:00:00.000Z';
  const expired = rec('old', 'shared', 500, '2026-01-01T00:00:00.000Z');
  const surviving = rec('new', 'shared', 500, '2026-05-30T00:00:00.000Z');

  const plan = planAttachmentEviction({ records: [expired, surviving], now, retentionDays: 90 });
  assert.deepEqual(plan.recordIds, ['old'], 'the expired RECORD still goes');
  assert.deepEqual(plan.orphanedHashes, [], 'but its blob is still in use');
  assert.equal(plan.reclaimedBytes, 0, 'so nothing was actually reclaimed');
});

test('reclaimed bytes count a freed blob once, not once per record', () => {
  // Ten records sharing one blob free it a single time. Reporting ten times the
  // real figure would make a sweep look effective while the disk stayed full.
  const now = '2026-06-01T00:00:00.000Z';
  const old = '2026-01-01T00:00:00.000Z';
  const records = Array.from({ length: 10 }, (_, i) => rec(`r${i}`, 'same', 1_000, old));

  const plan = planAttachmentEviction({ records, now, retentionDays: 90 });
  assert.equal(plan.recordIds.length, 10);
  assert.deepEqual(plan.orphanedHashes, ['same']);
  assert.equal(plan.reclaimedBytes, 1_000);
});

test('pinned records survive regardless of age', () => {
  const now = '2026-06-01T00:00:00.000Z';
  const old = rec('old', 'h1', 100, '2026-01-01T00:00:00.000Z');
  const plan = planAttachmentEviction({ records: [old], now, retentionDays: 90, pinned: ['old'] });
  assert.deepEqual(plan.recordIds, []);
  assert.equal(plan.reclaimedBytes, 0);
});

test('nothing is evicted when everything is inside the window', () => {
  const now = '2026-06-01T00:00:00.000Z';
  const plan = planAttachmentEviction({
    records: [rec('a', 'h', 10, '2026-05-31T00:00:00.000Z')], now, retentionDays: 90,
  });
  assert.deepEqual(plan.recordIds, []);
  assert.deepEqual(plan.orphanedHashes, []);
});
