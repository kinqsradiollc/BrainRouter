/**
 * ADR-027 D4 (P2-1/P2-2) — attachment storage policy: dedup, quota, retention,
 * and safe deletion.
 *
 * Today every ingest writes a fresh copy even though `sha256` is already
 * computed, there is no quota, and nothing ever reclaims bytes. This module is
 * the decision layer for all four, kept pure so the rules are testable without
 * touching a filesystem.
 *
 * THE REFCOUNT RULE IS THE LOAD-BEARING PART. Content-addressed storage means
 * two records can name the same blob. Deleting a record must therefore remove
 * the blob only when NO other record still references that hash — otherwise
 * deleting one attachment silently destroys another's bytes, which is a data
 * loss bug dressed up as a space optimisation. Every deletion goes through
 * {@link planAttachmentDeletion}; nothing should unlink a blob directly.
 */

import type { AttachmentRecord } from '@kinqs/brainrouter-types';

/** Owner-approved retention: full detail for this long, then reclaimable. */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;

export interface AttachmentQuota {
  /** Reject an ingest that would push the workspace past this. 0 = unlimited. */
  maxTotalBytes?: number;
  /** Reject a single file larger than this. 0 = unlimited. */
  maxFileBytes?: number;
}

export type IngestPlan =
  /** An identical blob is already stored; reference it instead of copying. */
  | { action: 'reuse'; existingId: string; reclaimedBytes: number }
  /** New content — write it. */
  | { action: 'store' }
  /** Refused. `reason` is user-facing. */
  | { action: 'reject'; reason: string };

export interface IngestPlanInput {
  sha256: string;
  byteSize: number;
  /** Records already in this workspace. */
  existing: readonly Pick<AttachmentRecord, 'id' | 'sha256' | 'byteSize'>[];
  quota?: AttachmentQuota;
}

function bytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} bytes`;
}

/**
 * Decide what to do with an incoming attachment.
 *
 * Dedup is checked BEFORE quota on purpose: re-attaching a file the workspace
 * already holds costs no new bytes, so refusing it for being "over quota" would
 * be both wrong and baffling to the user.
 */
export function planAttachmentIngest(input: IngestPlanInput): IngestPlan {
  const duplicate = input.existing.find((record) => record.sha256 === input.sha256);
  if (duplicate) {
    return { action: 'reuse', existingId: duplicate.id, reclaimedBytes: input.byteSize };
  }

  const maxFile = input.quota?.maxFileBytes ?? 0;
  if (maxFile > 0 && input.byteSize > maxFile) {
    return {
      action: 'reject',
      reason: `This file is ${bytes(input.byteSize)}, over the ${bytes(maxFile)} per-file limit.`,
    };
  }

  const maxTotal = input.quota?.maxTotalBytes ?? 0;
  if (maxTotal > 0) {
    // Distinct blobs only — counting a shared blob twice would overstate usage
    // and reject an ingest the workspace has room for.
    const seen = new Set<string>();
    let used = 0;
    for (const record of input.existing) {
      if (seen.has(record.sha256)) continue;
      seen.add(record.sha256);
      used += record.byteSize;
    }
    if (used + input.byteSize > maxTotal) {
      return {
        action: 'reject',
        reason: `Storing this would use ${bytes(used + input.byteSize)} of the `
          + `${bytes(maxTotal)} workspace limit. Remove some attachments first.`,
      };
    }
  }

  return { action: 'store' };
}

export interface DeletionPlan {
  /** Always true — the record row goes regardless. */
  removeRecord: true;
  /**
   * Whether the underlying blob may be unlinked. False when another record
   * still references this hash.
   */
  removeBlob: boolean;
  /** Records that keep the blob alive, for diagnostics. */
  stillReferencedBy: readonly string[];
}

/**
 * Decide whether deleting a record may also unlink its blob.
 *
 * This exists because content-addressed storage makes the naive answer wrong.
 * Under dedup, "delete the record, delete its file" destroys the bytes of every
 * other record sharing that hash.
 */
export function planAttachmentDeletion(
  target: Pick<AttachmentRecord, 'id' | 'sha256'>,
  all: readonly Pick<AttachmentRecord, 'id' | 'sha256'>[],
): DeletionPlan {
  const others = all
    .filter((record) => record.id !== target.id && record.sha256 === target.sha256)
    .map((record) => record.id);
  return { removeRecord: true, removeBlob: others.length === 0, stillReferencedBy: others };
}

export interface EvictionInput {
  records: readonly Pick<AttachmentRecord, 'id' | 'sha256' | 'byteSize' | 'updatedAt'>[];
  /** ISO timestamp to measure age against. */
  now: string;
  retentionDays?: number;
  /** Ids that must survive regardless of age (still referenced by live work). */
  pinned?: readonly string[];
}

export interface EvictionPlan {
  /** Record ids to remove, oldest first. */
  recordIds: readonly string[];
  /** Blob hashes that become unreferenced once those records are gone. */
  orphanedHashes: readonly string[];
  /** Bytes actually reclaimed — counts each freed blob ONCE. */
  reclaimedBytes: number;
}

/**
 * Plan a retention sweep.
 *
 * `reclaimedBytes` counts each freed blob once rather than summing record
 * sizes: under dedup, ten records sharing one blob free that blob's bytes a
 * single time, and reporting ten times the real figure would make the sweep
 * look effective while the disk stayed full.
 */
export function planAttachmentEviction(input: EvictionInput): EvictionPlan {
  const days = Math.max(1, Math.floor(input.retentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS));
  const cutoff = Date.parse(input.now) - days * 86_400_000;
  const pinned = new Set(input.pinned ?? []);

  const expired = input.records
    .filter((record) => !pinned.has(record.id) && Date.parse(record.updatedAt) < cutoff)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const expiredIds = new Set(expired.map((record) => record.id));

  // A hash is orphaned only when EVERY record naming it is being evicted.
  const survivingHashes = new Set(
    input.records.filter((record) => !expiredIds.has(record.id)).map((record) => record.sha256),
  );
  const orphaned = new Map<string, number>();
  for (const record of expired) {
    if (survivingHashes.has(record.sha256)) continue;
    if (!orphaned.has(record.sha256)) orphaned.set(record.sha256, record.byteSize);
  }

  return {
    recordIds: expired.map((record) => record.id),
    orphanedHashes: [...orphaned.keys()],
    reclaimedBytes: [...orphaned.values()].reduce((sum, size) => sum + size, 0),
  };
}
