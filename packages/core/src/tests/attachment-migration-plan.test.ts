/**
 * ADR-027 D4 (P2-1) — planning the move to content-addressed storage.
 *
 * This is the one migration in the release where being wrong is unrecoverable:
 * every other module added here is inert until wired, whereas a bad plan
 * deletes a user's files. So the plan is computed, verified against its own
 * inputs, and only then executed — and `verifyMigrationPlan` deliberately
 * re-derives its checks from the records rather than trusting the planner,
 * because checking a plan with the code that produced it is the same
 * assumption twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planAttachmentMigration,
  verifyMigrationPlan,
  describeMigrationPlan,
  blobPath,
  type LegacyAttachment,
} from '../attachment/policy/migrationPlan.js';

const rec = (
  id: string,
  sha256: string,
  byteSize = 100,
  present = true,
): LegacyAttachment => ({ id, sha256, byteSize, present, storedPath: `attachments/${id}/file.bin` });

test('duplicates collapse to one blob referenced by every record', () => {
  const plan = planAttachmentMigration([rec('att_2', 'aaa'), rec('att_1', 'aaa'), rec('att_3', 'bbb')]);
  assert.equal(plan.blobCount, 2);
  const shared = plan.blobs.find((b) => b.sha256 === 'aaa')!;
  assert.deepEqual(shared.referencedBy, ['att_1', 'att_2']);
  assert.equal(shared.sourceRecordId, 'att_1', 'lowest id seeds the blob, deterministically');
});

test('reclaimed bytes count redundant COPIES, not every record', () => {
  // Three records sharing one 100-byte blob free 200 bytes, not 300 — the blob
  // itself still occupies space. Reporting 300 would promise space that never
  // appears.
  const plan = planAttachmentMigration([rec('a', 'same'), rec('b', 'same'), rec('c', 'same')]);
  assert.equal(plan.reclaimedBytes, 200);
});

test('unique files reclaim nothing', () => {
  const plan = planAttachmentMigration([rec('a', 'x'), rec('b', 'y')]);
  assert.equal(plan.reclaimedBytes, 0);
  assert.equal(plan.blobCount, 2);
});

test('the plan is deterministic across input orderings', () => {
  // A plan that reshuffles cannot be reviewed and then trusted to execute the
  // same way, which defeats the purpose of a dry run.
  const records = [rec('c', 'bbb'), rec('a', 'aaa'), rec('b', 'aaa')];
  const first = planAttachmentMigration(records);
  const second = planAttachmentMigration([...records].reverse());
  assert.deepEqual(
    first.blobs.map((b) => `${b.sha256}:${b.sourceRecordId}`),
    second.blobs.map((b) => `${b.sha256}:${b.sourceRecordId}`),
  );
  assert.deepEqual(first.removablePaths, second.removablePaths);
});

test('a record with a missing file is reported and left entirely alone', () => {
  // A broken record is a bug to investigate; destroying the evidence makes that
  // impossible, so it gets no blob and its path is not scheduled for removal.
  const plan = planAttachmentMigration([rec('good', 'aaa'), rec('broken', 'bbb', 100, false)]);
  assert.deepEqual(plan.brokenRecords, ['broken']);
  assert.equal(plan.blobCount, 1);
  assert.equal(plan.recordCount, 1);
  assert.ok(!plan.removablePaths.some((p) => p.includes('broken')));
  assert.ok(!plan.blobs.some((b) => b.referencedBy.includes('broken')));
});

test('blob paths are sharded so no directory grows unbounded', () => {
  const path = blobPath('abcdef0123456789');
  assert.equal(path, 'attachments/blobs/ab/abcdef0123456789');
  assert.equal(blobPath('ff00', 'custom/root'), 'custom/root/ff/ff00');
});

test('a valid plan verifies clean', () => {
  const records = [rec('a', 'aaa'), rec('b', 'aaa'), rec('c', 'bbb')];
  assert.deepEqual(verifyMigrationPlan(planAttachmentMigration(records), records), []);
});

test('verification catches a record left uncovered', () => {
  const records = [rec('a', 'aaa'), rec('b', 'bbb')];
  const plan = planAttachmentMigration(records);
  const tampered = { ...plan, blobs: plan.blobs.filter((b) => b.sha256 !== 'bbb') };
  const problems = verifyMigrationPlan(tampered, records);
  assert.ok(problems.some((p) => /Record b is not covered/.test(p)));
});

test('verification catches a removal with no blob holding the content', () => {
  // The exact shape of the unrecoverable failure: delete the file, keep nothing.
  const records = [rec('a', 'aaa')];
  const plan = planAttachmentMigration(records);
  const tampered = { ...plan, blobs: [] };
  const problems = verifyMigrationPlan(tampered, records);
  assert.ok(problems.some((p) => /no blob holding its content/.test(p)));
});

test('verification catches a path that belongs to no record', () => {
  const records = [rec('a', 'aaa')];
  const plan = planAttachmentMigration(records);
  const tampered = { ...plan, removablePaths: [...plan.removablePaths, 'attachments/stray/x.bin'] };
  assert.ok(verifyMigrationPlan(tampered, records).some((p) => /does not belong to any record/.test(p)));
});

test('verification catches a broken record wrongly assigned a blob', () => {
  const records = [rec('broken', 'aaa', 100, false)];
  const tampered = {
    ...planAttachmentMigration(records),
    blobs: [{
      sha256: 'aaa', targetPath: blobPath('aaa'), sourceRecordId: 'broken',
      sourcePath: 'attachments/broken/file.bin', byteSize: 100, referencedBy: ['broken'],
    }],
  };
  assert.ok(verifyMigrationPlan(tampered, records).some((p) => /must not be assigned a blob/.test(p)));
});

test('verification catches a record referenced by two blobs', () => {
  const records = [rec('a', 'aaa')];
  const plan = planAttachmentMigration(records);
  const duplicated = { ...plan, blobs: [plan.blobs[0]!, { ...plan.blobs[0]!, sha256: 'other' }] };
  assert.ok(verifyMigrationPlan(duplicated, records).some((p) => /more than one blob/.test(p)));
});

test('the dry-run summary names broken records rather than counting them', () => {
  const plan = planAttachmentMigration([rec('a', 'x'), rec('bad', 'y', 100, false)]);
  const text = describeMigrationPlan(plan);
  assert.match(text, /1 record\(s\) → 1 distinct blob/);
  assert.match(text, /bad/, 'a bare number invites ignoring it');
});

test('an empty set plans nothing and verifies clean', () => {
  const plan = planAttachmentMigration([]);
  assert.equal(plan.blobCount, 0);
  assert.equal(plan.recordCount, 0);
  assert.deepEqual(verifyMigrationPlan(plan, []), []);
});

test('a record with no `present` flag is rejected, not silently treated as broken', () => {
  // Found by dry-running against real records: the attachment store's JSON has
  // no `present` field, so a caller that deserializes it straight into the
  // planner passes undefined for every record. Read as falsy that means "all
  // broken", and the migration becomes a no-op that still reports success —
  // total, invisible failure. It must be loud instead.
  const withoutFlag = [
    { id: 'att_a', storedPath: '/w/a', sha256: 'aa', byteSize: 1 },
  ] as unknown as Parameters<typeof planAttachmentMigration>[0];
  assert.throws(() => planAttachmentMigration(withoutFlag), /no `present` flag/);
});

test('an explicit present:false is still honoured as a broken record', () => {
  // The guard must reject ABSENCE of the flag without breaking the legitimate
  // "I checked and the file is gone" case the planner exists to report.
  const plan = planAttachmentMigration([
    { id: 'att_a', storedPath: '/w/a', sha256: 'aa', byteSize: 1, present: false },
    { id: 'att_b', storedPath: '/w/b', sha256: 'bb', byteSize: 2, present: true },
  ]);
  assert.deepEqual(plan.brokenRecords, ['att_a']);
  assert.equal(plan.recordCount, 1);
  assert.equal(plan.blobCount, 1);
});
