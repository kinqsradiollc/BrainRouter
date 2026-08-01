/**
 * ADR-027 D4 (P2-1) — carrying out the content-addressed storage migration.
 *
 * Separated from the planner on purpose. The plan is inspectable and verifiable
 * before anything moves; this is the part that moves things, and it is written
 * to be as boring and as interruptible as possible.
 *
 * Four rules, each because the alternative loses data:
 *
 *   - VERIFY FIRST, ALWAYS. The plan is re-checked against the records at
 *     execution time even if the caller already verified it. A plan is data; it
 *     can be stale, edited, or from a different run.
 *   - COPY, THEN VERIFY, THEN REMOVE. Never move. A copy that fails leaves the
 *     original intact; a move that fails halfway leaves nothing.
 *   - NO REMOVAL UNTIL EVERY BLOB EXISTS. Removals happen in a second pass
 *     after all copies succeed, so a failure midway through copying cannot have
 *     already deleted an original.
 *   - RESUMABLE AND IDEMPOTENT. A blob that already exists is not re-copied; a
 *     path already gone is not an error. Interrupting the process and running
 *     it again must converge, because it WILL be interrupted eventually.
 */

import {
  verifyMigrationPlan,
  type LegacyAttachment,
  type MigrationPlan,
} from './migrationPlan.js';

/**
 * The filesystem operations this needs. Injected so the executor is testable
 * without touching real files, and so a caller can supply a transactional or
 * instrumented implementation.
 */
export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  /** Copy, creating parent directories. Must not clobber an existing target. */
  copy(from: string, to: string): Promise<void>;
  /** Size in bytes, for post-copy verification. */
  size(path: string): Promise<number>;
  /** Remove a file. Absent is success, not an error. */
  remove(path: string): Promise<void>;
}

export class MigrationAbortedError extends Error {
  constructor(message: string, public readonly problems: readonly string[] = []) {
    super(message);
    this.name = 'MigrationAbortedError';
  }
}

export interface MigrationOutcome {
  blobsCreated: number;
  blobsAlreadyPresent: number;
  pathsRemoved: number;
  pathsAlreadyGone: number;
  /** True when nothing was written — a dry run, or an already-complete migration. */
  dryRun: boolean;
}

/**
 * Execute a migration plan.
 *
 * `dryRun` performs every check and reports what WOULD happen without writing.
 * It is the default: an executor that migrates by accident when someone forgets
 * an argument is not one you can safely put in a script.
 */
export async function executeMigration(input: {
  plan: MigrationPlan;
  records: readonly LegacyAttachment[];
  fs: MigrationFs;
  dryRun?: boolean;
}): Promise<MigrationOutcome> {
  const dryRun = input.dryRun !== false;

  // Re-verify even if the caller did. A plan is data — it can be stale, hand
  // edited, or produced from a different set of records than the one passed
  // here, and every one of those ends with deleting a file nothing holds.
  const problems = verifyMigrationPlan(input.plan, input.records);
  if (problems.length > 0) {
    throw new MigrationAbortedError(
      `Refusing to migrate: ${problems.length} problem(s) in the plan`,
      problems,
    );
  }

  let blobsCreated = 0;
  let blobsAlreadyPresent = 0;

  // PASS ONE — copy every blob into place. No removals happen in this pass, so
  // a failure here cannot have deleted an original.
  for (const blob of input.plan.blobs) {
    if (await input.fs.exists(blob.targetPath)) {
      // Resume case: a previous interrupted run already placed it.
      blobsAlreadyPresent += 1;
      continue;
    }
    if (dryRun) { blobsCreated += 1; continue; }

    if (!await input.fs.exists(blob.sourcePath)) {
      throw new MigrationAbortedError(
        `Source file vanished during migration: ${blob.sourcePath} (blob ${blob.sha256})`,
      );
    }
    await input.fs.copy(blob.sourcePath, blob.targetPath);

    // Verify the copy landed before anything is allowed to be removed on its
    // authority. A truncated copy that nobody checks is a silent data loss
    // discovered months later.
    const written = await input.fs.size(blob.targetPath);
    if (written !== blob.byteSize) {
      throw new MigrationAbortedError(
        `Copy verification failed for ${blob.sha256}: expected ${blob.byteSize} bytes, wrote ${written}`,
      );
    }
    blobsCreated += 1;
  }

  // PASS TWO — only now, with every blob present and verified, remove the old
  // per-record copies.
  let pathsRemoved = 0;
  let pathsAlreadyGone = 0;
  for (const path of input.plan.removablePaths) {
    if (!await input.fs.exists(path)) { pathsAlreadyGone += 1; continue; }
    if (dryRun) { pathsRemoved += 1; continue; }
    await input.fs.remove(path);
    pathsRemoved += 1;
  }

  return { blobsCreated, blobsAlreadyPresent, pathsRemoved, pathsAlreadyGone, dryRun };
}

/** Human-readable outcome, distinguishing a dry run from a real one. */
export function describeMigrationOutcome(outcome: MigrationOutcome): string {
  const verb = outcome.dryRun ? 'would create' : 'created';
  const removed = outcome.dryRun ? 'would remove' : 'removed';
  const parts = [
    `${verb} ${outcome.blobsCreated} blob(s)`,
    `${removed} ${outcome.pathsRemoved} legacy path(s)`,
  ];
  if (outcome.blobsAlreadyPresent > 0) {
    parts.push(`${outcome.blobsAlreadyPresent} blob(s) already in place (resumed)`);
  }
  if (outcome.pathsAlreadyGone > 0) parts.push(`${outcome.pathsAlreadyGone} path(s) already gone`);
  return `${outcome.dryRun ? 'DRY RUN — ' : ''}${parts.join(' · ')}`;
}
