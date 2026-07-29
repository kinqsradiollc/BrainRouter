/**
 * Workspace-onboarding transaction contracts and fixed storage limits.
 *
 * Extracted verbatim from the coordinator with no behavior or public-surface
 * change. Persistence, recovery, and filesystem operations remain in the
 * coordinator until their own dependency-ordered extraction slices.
 */
import path from 'node:path';

export const INSTRUCTION_RELPATH = 'AGENT.md';
export const MANIFEST_RELPATH = path.join('.brainrouter', 'workspace.json');
export const INSTRUCTION_MAX_BYTES = 4 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_LIMIT = 16;

export type PairPhase =
  | 'prepared'
  | 'instruction-committing'
  | 'instruction-written'
  | 'manifest-committing'
  | 'manifest-written'
  | 'ambiguous';

export interface WorkspaceOnboardingFileSnapshot {
  existed: boolean;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  contents?: Buffer;
}

export interface WorkspaceOnboardingPairTransaction {
  workspaceRoot: string;
  token: string;
  receiptPath: string;
}

export interface WorkspaceOnboardingManifestClaimFingerprint {
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface WorkspaceOnboardingManifestReplacementFingerprint {
  size: number;
  sha256: string;
}

export interface EncodedFileVersion {
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  sha256: string;
}

export interface EncodedFileSnapshot {
  existed: boolean;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  sha256?: string;
  contentsBase64?: string;
}

export interface DesiredFileVersion {
  size: number;
  sha256: string;
}

export interface StagedFileVersion extends EncodedFileVersion {
  temporaryPath: string;
}

export interface WorkspaceOnboardingPairReceipt {
  version: 1;
  phase: PairPhase;
  workspaceRoot: string;
  token: string;
  instruction: {
    before: EncodedFileSnapshot;
    desired: DesiredFileVersion;
    staged?: StagedFileVersion;
    outcome?: 'created' | 'unchanged';
    after?: EncodedFileVersion;
  };
  manifest: {
    before: EncodedFileSnapshot;
    desired: DesiredFileVersion;
    after?: EncodedFileVersion;
  };
}

export interface ActivePairTransaction {
  transaction: WorkspaceOnboardingPairTransaction;
  receipt: WorkspaceOnboardingPairReceipt;
}
