import type { RepositoryRevision } from './program.js';

export const SOURCE_SNAPSHOT_STATUSES = [
  'pending',
  'ready',
  'partial',
  'failed',
  'stale',
] as const;

export type SourceSnapshotStatus = (typeof SOURCE_SNAPSHOT_STATUSES)[number];

/** Secret-free receipt for an isolated checkout and inventory. */
export interface SourceSnapshot {
  id: string;
  revision: RepositoryRevision;
  status: SourceSnapshotStatus;
  checkoutRef?: string;
  inventoryRef?: string;
  fileCount: number;
  textFileCount: number;
  indexedFileCount: number;
  unsupportedFileCount: number;
  byteCount?: number;
  createdAt: string;
  completedAt?: string;
  errorCode?: string;
}
