/**
 * ADR-027 D4 (P2-1) — planning the move to content-addressed storage.
 *
 * Attachments live at `attachments/<id>/<name>` today: one directory per
 * record, so the same file attached twice is stored twice. Content addressing
 * fixes that, but the migration is the one piece of this release where being
 * wrong is UNRECOVERABLE — every other module added here is inert until wired,
 * whereas a bad migration deletes a user's files.
 *
 * So the plan is computed and inspected BEFORE anything moves. This module
 * produces that plan and nothing else: no filesystem access, no mutation. The
 * executor that carries it out is a separate, small step that can be reviewed
 * against a plan already proven correct on real records.
 *
 * The properties worth checking before trusting it:
 *
 *   - Every record ends up pointing at exactly one blob.
 *   - No blob is scheduled for deletion while a record still references it.
 *   - Reclaimed bytes are counted once per blob, not once per record.
 *   - A record whose file is missing is REPORTED, never quietly dropped.
 */

export interface LegacyAttachment {
  id: string;
  /** Current on-disk path, per-record. */
  storedPath: string;
  sha256: string;
  byteSize: number;
  /** False when the file is absent from disk — a broken record. */
  present: boolean;
}

export interface BlobPlacement {
  sha256: string;
  /** Destination path, content-addressed. */
  targetPath: string;
  /** The record whose file is copied to seed this blob. */
  sourceRecordId: string;
  sourcePath: string;
  byteSize: number;
  /** Every record that will point at this blob afterwards. */
  referencedBy: readonly string[];
}

export interface MigrationPlan {
  /** One entry per distinct blob, sorted by hash for a deterministic plan. */
  blobs: readonly BlobPlacement[];
  /** Old per-record paths safe to remove once their blob exists. */
  removablePaths: readonly string[];
  /**
   * Records whose file is missing. Migration must NOT invent a blob for these,
   * and must not delete their row either — a broken record is a bug to
   * investigate, and destroying the evidence makes that impossible.
   */
  brokenRecords: readonly string[];
  /** Bytes freed by de-duplication: counted once per redundant COPY. */
  reclaimedBytes: number;
  /** Distinct blobs after migration. */
  blobCount: number;
  /** Records the plan covers, excluding broken ones. */
  recordCount: number;
}

/** Content-addressed path for a blob. Sharded so no directory grows unbounded. */
export function blobPath(sha256: string, root = 'attachments/blobs'): string {
  // Two-character prefix directory: 256 buckets is enough that no single
  // directory holds every attachment, which some filesystems handle badly and
  // every `ls` handles slowly.
  return `${root}/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Compute the migration without touching anything.
 *
 * Deterministic: blobs sort by hash, and the seeding record for a blob is the
 * lowest id among those sharing it. Two runs over the same records produce an
 * identical plan, which is what makes a dry run meaningful — a plan that
 * reshuffles cannot be reviewed and then trusted to execute the same way.
 */
export function planAttachmentMigration(
  records: readonly LegacyAttachment[],
  options: { blobRoot?: string } = {},
): MigrationPlan {
  const broken = records.filter((record) => !record.present);
  const usable = records.filter((record) => record.present);

  const byHash = new Map<string, LegacyAttachment[]>();
  for (const record of usable) {
    const group = byHash.get(record.sha256);
    if (group) group.push(record);
    else byHash.set(record.sha256, [record]);
  }

  const blobs: BlobPlacement[] = [];
  const removablePaths: string[] = [];
  let reclaimedBytes = 0;

  for (const [sha256, group] of [...byHash.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const seed = ordered[0]!;
    blobs.push({
      sha256,
      targetPath: blobPath(sha256, options.blobRoot),
      sourceRecordId: seed.id,
      sourcePath: seed.storedPath,
      byteSize: seed.byteSize,
      referencedBy: ordered.map((record) => record.id),
    });
    // Every old path becomes removable once the blob exists — including the
    // seed's, since the blob is a copy rather than a move. Reclaimed bytes
    // count the REDUNDANT copies only: the blob itself still occupies space.
    for (const record of ordered) removablePaths.push(record.storedPath);
    reclaimedBytes += seed.byteSize * (ordered.length - 1);
  }

  return {
    blobs,
    removablePaths: [...removablePaths].sort(),
    brokenRecords: broken.map((record) => record.id).sort(),
    reclaimedBytes,
    blobCount: blobs.length,
    recordCount: usable.length,
  };
}

/**
 * Check a plan against its inputs before executing it.
 *
 * Returns the problems found, empty when the plan is safe. This exists because
 * "the planner looked right" is not the standard for something that deletes
 * files — the plan must be verifiable independently of the code that produced
 * it, or the check is just the same assumption twice.
 */
export function verifyMigrationPlan(
  plan: MigrationPlan,
  records: readonly LegacyAttachment[],
): readonly string[] {
  const problems: string[] = [];
  const usable = records.filter((record) => record.present);

  const covered = new Set(plan.blobs.flatMap((blob) => blob.referencedBy));
  for (const record of usable) {
    if (!covered.has(record.id)) problems.push(`Record ${record.id} is not covered by any blob`);
  }

  const seenTwice = new Set<string>();
  for (const id of plan.blobs.flatMap((blob) => blob.referencedBy)) {
    if (seenTwice.has(id)) problems.push(`Record ${id} is referenced by more than one blob`);
    seenTwice.add(id);
  }

  // Nothing may be removed unless a blob will hold that content.
  const survivingHashes = new Set(plan.blobs.map((blob) => blob.sha256));
  const pathToHash = new Map(usable.map((record) => [record.storedPath, record.sha256]));
  for (const path of plan.removablePaths) {
    const hash = pathToHash.get(path);
    if (hash === undefined) {
      problems.push(`Path scheduled for removal does not belong to any record: ${path}`);
    } else if (!survivingHashes.has(hash)) {
      problems.push(`Path ${path} would be removed with no blob holding its content`);
    }
  }

  for (const id of plan.brokenRecords) {
    if (covered.has(id)) problems.push(`Broken record ${id} must not be assigned a blob`);
  }

  return problems;
}

/** Human-readable dry-run summary. */
export function describeMigrationPlan(plan: MigrationPlan): string {
  const parts = [
    `${plan.recordCount} record(s) → ${plan.blobCount} distinct blob(s)`,
    `${(plan.reclaimedBytes / 1_000_000).toFixed(2)} MB reclaimed from duplicate copies`,
  ];
  if (plan.brokenRecords.length > 0) {
    // Named, not counted: a broken record is a bug to investigate, and a bare
    // number invites ignoring it.
    parts.push(`**${plan.brokenRecords.length} record(s) with a missing file, left untouched**: `
      + plan.brokenRecords.slice(0, 5).join(', '));
  }
  return parts.join(' · ');
}
