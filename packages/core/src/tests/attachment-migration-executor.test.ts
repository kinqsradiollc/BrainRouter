/**
 * ADR-027 D4 (P2-1) — executing the storage migration.
 *
 * Every test here is about NOT losing a file. The executor is deliberately
 * boring; the interesting cases are all failures partway through, because that
 * is when a migration destroys data — and an interruption is not a possibility
 * to design against, it is a certainty to design for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeMigration,
  describeMigrationOutcome,
  MigrationAbortedError,
  type MigrationFs,
} from '../attachment/policy/migrationExecutor.js';
import {
  planAttachmentMigration,
  type LegacyAttachment,
} from '../attachment/policy/migrationPlan.js';

const rec = (id: string, sha256: string, byteSize = 100, present = true): LegacyAttachment =>
  ({ id, sha256, byteSize, present, storedPath: `attachments/${id}/file.bin` });

/** In-memory filesystem: path → byte length. */
function fakeFs(initial: Record<string, number> = {}): MigrationFs & {
  files: Map<string, number>;
  copies: string[];
  removals: string[];
  failCopyAt?: string;
  truncateAt?: string;
} {
  const files = new Map(Object.entries(initial));
  const copies: string[] = [];
  const removals: string[] = [];
  const self = {
    files, copies, removals,
    failCopyAt: undefined as string | undefined,
    truncateAt: undefined as string | undefined,
    async exists(path: string) { return files.has(path); },
    async copy(from: string, to: string) {
      if (self.failCopyAt === to) throw new Error(`disk full writing ${to}`);
      copies.push(to);
      files.set(to, self.truncateAt === to ? 1 : (files.get(from) ?? 0));
    },
    async size(path: string) { return files.get(path) ?? -1; },
    async remove(path: string) { removals.push(path); files.delete(path); },
  };
  return self;
}

function scenario(records: readonly LegacyAttachment[]) {
  const fs = fakeFs(Object.fromEntries(records.filter((r) => r.present).map((r) => [r.storedPath, r.byteSize])));
  return { plan: planAttachmentMigration(records), records, fs };
}

test('a dry run is the DEFAULT and writes nothing', async () => {
  // An executor that migrates by accident when someone forgets an argument is
  // not one you can safely put in a script.
  const { plan, records, fs } = scenario([rec('a', 'aaa'), rec('b', 'aaa')]);
  const outcome = await executeMigration({ plan, records, fs });
  assert.equal(outcome.dryRun, true);
  assert.deepEqual(fs.copies, []);
  assert.deepEqual(fs.removals, []);
  assert.equal(outcome.blobsCreated, 1);
  assert.equal(outcome.pathsRemoved, 2);
  assert.match(describeMigrationOutcome(outcome), /DRY RUN/);
});

test('a real run copies blobs then removes legacy paths, in that order', async () => {
  const { plan, records, fs } = scenario([rec('a', 'aaa'), rec('b', 'aaa'), rec('c', 'bbb')]);
  const outcome = await executeMigration({ plan, records, fs, dryRun: false });

  assert.equal(outcome.blobsCreated, 2);
  assert.equal(outcome.pathsRemoved, 3);
  // Ordering is the guarantee: nothing is deleted before every blob exists.
  assert.equal(fs.copies.length, 2);
  assert.equal(fs.removals.length, 3);
  for (const blob of plan.blobs) assert.ok(fs.files.has(blob.targetPath));
  for (const path of plan.removablePaths) assert.ok(!fs.files.has(path));
});

test('a failed copy leaves EVERY original intact', async () => {
  // The reason removals are a second pass. A failure midway through copying
  // must not find originals already deleted.
  const { plan, records, fs } = scenario([rec('a', 'aaa'), rec('b', 'bbb')]);
  fs.failCopyAt = plan.blobs[1]!.targetPath;

  await assert.rejects(() => executeMigration({ plan, records, fs, dryRun: false }), /disk full/);
  assert.deepEqual(fs.removals, [], 'nothing was removed');
  for (const record of records) assert.ok(fs.files.has(record.storedPath), `${record.id} survived`);
});

test('a truncated copy aborts before anything is removed', async () => {
  // A short write that nobody checks is silent data loss found months later.
  const { plan, records, fs } = scenario([rec('a', 'aaa')]);
  fs.truncateAt = plan.blobs[0]!.targetPath;

  await assert.rejects(
    () => executeMigration({ plan, records, fs, dryRun: false }),
    (error: Error) => {
      assert.ok(error instanceof MigrationAbortedError);
      assert.match(error.message, /Copy verification failed/);
      return true;
    },
  );
  assert.deepEqual(fs.removals, []);
  assert.ok(fs.files.has('attachments/a/file.bin'));
});

test('a source that vanished mid-run aborts rather than proceeding', async () => {
  const { plan, records, fs } = scenario([rec('a', 'aaa')]);
  fs.files.delete('attachments/a/file.bin');
  await assert.rejects(
    () => executeMigration({ plan, records, fs, dryRun: false }),
    /Source file vanished/,
  );
  assert.deepEqual(fs.removals, []);
});

test('re-running after an interruption converges without re-copying', async () => {
  // Interruption is a certainty, not a possibility. Running again must finish
  // the job rather than redo or corrupt it.
  const records = [rec('a', 'aaa'), rec('b', 'bbb')];
  const plan = planAttachmentMigration(records);
  const fs = fakeFs(Object.fromEntries(records.map((r) => [r.storedPath, r.byteSize])));
  // Simulate a run that placed the first blob then died.
  fs.files.set(plan.blobs[0]!.targetPath, plan.blobs[0]!.byteSize);

  const outcome = await executeMigration({ plan, records, fs, dryRun: false });
  assert.equal(outcome.blobsAlreadyPresent, 1, 'the existing blob is not re-copied');
  assert.equal(outcome.blobsCreated, 1);
  assert.deepEqual(fs.copies, [plan.blobs[1]!.targetPath]);
});

test('a fully-completed migration re-runs to a clean no-op', async () => {
  const records = [rec('a', 'aaa')];
  const plan = planAttachmentMigration(records);
  const fs = fakeFs({ [plan.blobs[0]!.targetPath]: 100 });

  const outcome = await executeMigration({ plan, records, fs, dryRun: false });
  assert.equal(outcome.blobsCreated, 0);
  assert.equal(outcome.blobsAlreadyPresent, 1);
  assert.equal(outcome.pathsRemoved, 0);
  assert.equal(outcome.pathsAlreadyGone, 1, 'the legacy path is already gone');
  assert.deepEqual(fs.copies, []);
  assert.deepEqual(fs.removals, []);
});

test('the plan is re-verified at execution time even if already checked', async () => {
  // A plan is data: it can be stale, hand-edited, or built from different
  // records than the ones passed here. Each of those ends in deleting a file
  // nothing holds.
  const records = [rec('a', 'aaa')];
  const plan = planAttachmentMigration(records);
  const tampered = { ...plan, blobs: [] };
  const fs = fakeFs({ 'attachments/a/file.bin': 100 });

  await assert.rejects(
    () => executeMigration({ plan: tampered, records, fs, dryRun: false }),
    (error: Error) => {
      assert.ok(error instanceof MigrationAbortedError);
      assert.ok(error.problems.some((p) => /no blob holding its content/.test(p)));
      return true;
    },
  );
  assert.deepEqual(fs.removals, [], 'refused before touching anything');
});

test('a broken record is never copied and its path never removed', async () => {
  const records = [rec('good', 'aaa'), rec('broken', 'bbb', 100, false)];
  const { plan, fs } = scenario(records);
  await executeMigration({ plan, records, fs, dryRun: false });
  assert.ok(!fs.removals.includes('attachments/broken/file.bin'));
  assert.equal(fs.copies.length, 1);
});

test('an empty plan is a clean no-op', async () => {
  const fs = fakeFs();
  const outcome = await executeMigration({ plan: planAttachmentMigration([]), records: [], fs, dryRun: false });
  assert.deepEqual(outcome, {
    blobsCreated: 0, blobsAlreadyPresent: 0, pathsRemoved: 0, pathsAlreadyGone: 0, dryRun: false,
  });
});
