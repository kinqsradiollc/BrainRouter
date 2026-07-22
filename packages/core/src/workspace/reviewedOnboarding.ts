/**
 * Confirmation-only persistence for a reviewed workspace setup proposal.
 *
 * Clients receive opaque revisions while they edit. Saving rechecks both
 * project files immediately before commit, so a stale dialog cannot overwrite
 * a newer manifest or instruction file. When an instruction replacement is
 * approved, the existing durable pair coordinator makes it and the manifest
 * one recoverable logical change.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_RELPATH,
  normalizeWorkspaceManifest,
  saveWorkspaceManifest,
  serializeWorkspaceManifest,
  type WorkspaceManifest,
} from './manifest.js';
import {
  ONBOARDING_PROPOSAL_MAX_INSTRUCTION_BYTES,
  normalizeWorkspaceInstructionTarget,
} from './onboardingProposal.js';
import {
  beginWorkspaceOnboardingPairTransaction,
  completeWorkspaceOnboardingPairTransaction,
  endWorkspaceOnboardingPairTransaction,
  markWorkspaceOnboardingInstructionCommitting,
  markWorkspaceOnboardingManifestCommitting,
  recordWorkspaceOnboardingInstructionStaged,
  recordWorkspaceOnboardingInstructionWritten,
  recordWorkspaceOnboardingManifestWritten,
  recoverInterruptedWorkspaceOnboardingPair,
  type WorkspaceOnboardingFileSnapshot,
  type WorkspaceOnboardingPairTransaction,
} from './onboardingTransaction.js';
import {
  containsWorkspaceSecretMaterial,
} from './workspaceContentSafety.js';
import {
  openWorkspaceFileParentGuard,
  writeWorkspaceFileAtomic,
} from './fileWrite.js';

const INSTRUCTION_RELPATH = 'AGENT.md';
const INSTRUCTION_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export interface WorkspaceOnboardingReviewRevision {
  manifest: string;
  instruction: string;
}

export interface WorkspaceInstructionReviewSummary {
  path: typeof INSTRUCTION_RELPATH;
  existed: boolean;
  bytes: number;
  sha256: string | null;
}

export interface WorkspaceOnboardingReviewState {
  revision: WorkspaceOnboardingReviewRevision;
  instruction: WorkspaceInstructionReviewSummary;
}

export interface ReviewedWorkspaceOnboardingInput {
  manifest: WorkspaceManifest;
  expected: WorkspaceOnboardingReviewRevision;
  instruction?: {
    path: typeof INSTRUCTION_RELPATH;
    contents: string;
  };
}

export interface ReviewedWorkspaceOnboardingResult {
  manifest: WorkspaceManifest;
  manifestPath: string;
  instructionPath?: string;
  review: WorkspaceOnboardingReviewState;
}

/** Inspect only bounded metadata; existing instruction contents never leave core. */
export function inspectWorkspaceOnboardingReview(
  workspaceRoot: string,
): WorkspaceOnboardingReviewState {
  recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
  const manifest = snapshotWorkspaceFile(
    workspaceRoot,
    WORKSPACE_MANIFEST_RELPATH,
    WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const instruction = snapshotWorkspaceFile(
    workspaceRoot,
    INSTRUCTION_RELPATH,
    INSTRUCTION_SNAPSHOT_MAX_BYTES,
  );
  return reviewState(manifest, instruction);
}

/** Persist the exact normalized proposal only after both reviewed revisions match. */
export function commitReviewedWorkspaceOnboarding(
  workspaceRoot: string,
  input: ReviewedWorkspaceOnboardingInput,
): ReviewedWorkspaceOnboardingResult {
  assertRevision(input.expected);
  recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
  const manifestBefore = snapshotWorkspaceFile(
    workspaceRoot,
    WORKSPACE_MANIFEST_RELPATH,
    WORKSPACE_MANIFEST_MAX_BYTES,
  );
  const instructionBefore = snapshotWorkspaceFile(
    workspaceRoot,
    INSTRUCTION_RELPATH,
    INSTRUCTION_SNAPSHOT_MAX_BYTES,
  );
  const observed = reviewState(manifestBefore, instructionBefore);
  if (observed.revision.manifest !== input.expected.manifest ||
      observed.revision.instruction !== input.expected.instruction) {
    throw new Error('Workspace setup changed during review. Reload it before saving.');
  }

  const manifest = normalizeWorkspaceManifest(input.manifest);
  const manifestDesired = serializeWorkspaceManifest(manifest);
  const instructionDesired = validateInstruction(input.instruction);
  let pair: WorkspaceOnboardingPairTransaction | undefined;
  let failure: unknown;
  let manifestPath = '';
  try {
    if (instructionDesired !== undefined) {
      pair = beginWorkspaceOnboardingPairTransaction(workspaceRoot, {
        manifestBefore,
        manifestDesired,
        instructionBefore,
        instructionDesired,
      });
      markWorkspaceOnboardingInstructionCommitting(pair);
      writeWorkspaceFileAtomic(workspaceRoot, INSTRUCTION_RELPATH, instructionDesired, {
        exclusive: !instructionBefore.existed,
        ...(instructionBefore.mode === undefined ? {} : { mode: instructionBefore.mode }),
        onStaged: (staged) => recordWorkspaceOnboardingInstructionStaged(pair!, staged),
        beforeCommit: () => assertSnapshotUnchanged(
          workspaceRoot,
          INSTRUCTION_RELPATH,
          INSTRUCTION_SNAPSHOT_MAX_BYTES,
          instructionBefore,
          'Project instruction file changed during review.',
        ),
      });
      const instructionAfter = snapshotWorkspaceFile(
        workspaceRoot,
        INSTRUCTION_RELPATH,
        INSTRUCTION_SNAPSHOT_MAX_BYTES,
      );
      recordWorkspaceOnboardingInstructionWritten(pair, 'created', instructionAfter);
      markWorkspaceOnboardingManifestCommitting(pair);
    }

    manifestPath = saveWorkspaceManifest(workspaceRoot, manifest, {
      exclusive: !manifestBefore.existed,
      beforeCommit: () => assertSnapshotUnchanged(
        workspaceRoot,
        WORKSPACE_MANIFEST_RELPATH,
        WORKSPACE_MANIFEST_MAX_BYTES,
        manifestBefore,
        'Workspace manifest changed during review.',
      ),
    });
    const manifestAfter = snapshotWorkspaceFile(
      workspaceRoot,
      WORKSPACE_MANIFEST_RELPATH,
      WORKSPACE_MANIFEST_MAX_BYTES,
    );
    if (pair) {
      recordWorkspaceOnboardingManifestWritten(pair, manifestAfter);
      completeWorkspaceOnboardingPairTransaction(pair);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (pair) endWorkspaceOnboardingPairTransaction(pair);
  }

  if (failure !== undefined) {
    try {
      recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
    } catch (recoveryError) {
      throw new AggregateError(
        [failure, recoveryError],
        'Workspace setup failed and automatic recovery was incomplete.',
      );
    }
    throw failure;
  }

  return {
    manifest,
    manifestPath,
    ...(instructionDesired === undefined ? {} : { instructionPath: INSTRUCTION_RELPATH }),
    review: inspectWorkspaceOnboardingReview(workspaceRoot),
  };
}

function validateInstruction(
  instruction: ReviewedWorkspaceOnboardingInput['instruction'],
): string | undefined {
  if (instruction === undefined) return undefined;
  if (normalizeWorkspaceInstructionTarget(instruction.path) !== INSTRUCTION_RELPATH) {
    throw new Error('Unsupported workspace instruction path.');
  }
  const bytes = Buffer.byteLength(instruction.contents);
  if (bytes < 1 || bytes > ONBOARDING_PROPOSAL_MAX_INSTRUCTION_BYTES) {
    throw new Error('Workspace instruction proposal exceeds the review limit.');
  }
  if (containsWorkspaceSecretMaterial(instruction.contents) ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(instruction.contents)) {
    throw new Error('Workspace instruction proposal contains unsafe content.');
  }
  return instruction.contents;
}

function assertRevision(revision: WorkspaceOnboardingReviewRevision): void {
  if (!revision || !/^[0-9a-f]{64}$/.test(revision.manifest) ||
      !/^[0-9a-f]{64}$/.test(revision.instruction)) {
    throw new Error('Invalid workspace setup revision.');
  }
}

function assertSnapshotUnchanged(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
  expected: WorkspaceOnboardingFileSnapshot,
  message: string,
): void {
  const current = snapshotWorkspaceFile(workspaceRoot, relativePath, maxBytes);
  if (!snapshotsAreExact(expected, current)) throw new Error(message);
}

function reviewState(
  manifest: WorkspaceOnboardingFileSnapshot,
  instruction: WorkspaceOnboardingFileSnapshot,
): WorkspaceOnboardingReviewState {
  return {
    revision: {
      manifest: snapshotRevision(manifest),
      instruction: snapshotRevision(instruction),
    },
    instruction: {
      path: INSTRUCTION_RELPATH,
      existed: instruction.existed,
      bytes: instruction.size ?? 0,
      sha256: instruction.contents ? sha256(instruction.contents) : null,
    },
  };
}

function snapshotRevision(snapshot: WorkspaceOnboardingFileSnapshot): string {
  return sha256(Buffer.from(JSON.stringify({
    existed: snapshot.existed,
    mode: snapshot.mode ?? null,
    dev: snapshot.dev ?? null,
    ino: snapshot.ino ?? null,
    size: snapshot.size ?? null,
    mtimeMs: snapshot.mtimeMs ?? null,
    ctimeMs: snapshot.ctimeMs ?? null,
    sha256: snapshot.contents ? sha256(snapshot.contents) : null,
  })));
}

function snapshotWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
): WorkspaceOnboardingFileSnapshot {
  let guard;
  try {
    guard = openWorkspaceFileParentGuard(workspaceRoot, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
  try {
    guard.assertStable();
    let stat;
    try {
      stat = snapshotRegularFile(guard.accessTarget, maxBytes, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
      throw error;
    }
    guard.assertStable();
    return stat;
  } finally {
    guard.close();
  }
}

function snapshotRegularFile(
  target: string,
  maxBytes: number,
  label: string,
): WorkspaceOnboardingFileSnapshot {
  const pathStat = requireRegularFileStat(target, label);
  return readRegularFileSnapshot(target, pathStat, maxBytes, label);
}

function requireRegularFileStat(target: string, label: string): import('node:fs').Stats {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe ${label}: ${target}`);
  return stat;
}

function readRegularFileSnapshot(
  target: string,
  pathStat: import('node:fs').Stats,
  maxBytes: number,
  label: string,
): WorkspaceOnboardingFileSnapshot {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino || opened.size > maxBytes) {
      throw new Error(`Unsafe ${label}: ${target}`);
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`${label} changed while reading.`);
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() ||
        !sameStableFile(opened, after) || !sameStableFile(after, afterPath)) {
      throw new Error(`${label} changed while reading.`);
    }
    return {
      existed: true,
      mode: opened.mode & 0o777,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      contents,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameStableFile(left: import('node:fs').Stats, right: import('node:fs').Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o777) === (right.mode & 0o777) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function snapshotsAreExact(
  left: WorkspaceOnboardingFileSnapshot,
  right: WorkspaceOnboardingFileSnapshot,
): boolean {
  return left.existed === right.existed && (!left.existed || (
    left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.contents!.equals(right.contents!)
  ));
}

function sha256(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}
