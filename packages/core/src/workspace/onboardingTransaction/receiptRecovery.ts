/**
 * Workspace-onboarding receipt recovery service.
 *
 * A25-5c: owns deterministic rollback, owned-file cleanup, and ambiguous-state
 * preservation independently of the public transaction coordinator. Recovery
 * changes only filesystem identities proven by the durable receipt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  openWorkspaceFileParentGuard,
  writeWorkspaceFileAtomic,
  type WorkspaceFileParentGuard,
} from '../fileWrite.js';
import {
  INSTRUCTION_MAX_BYTES,
  INSTRUCTION_RELPATH,
  MANIFEST_MAX_BYTES,
  MANIFEST_RELPATH,
  type EncodedFileVersion,
  type WorkspaceOnboardingPairReceipt,
} from './contracts.js';
import {
  decodeSnapshotContents,
  snapshotMatchesDesired,
  snapshotMatchesEncodedSnapshot,
  snapshotMatchesVersion,
  snapshotRegularFile,
  snapshotWorkspaceFile,
} from './fileSnapshots.js';
import {
  markWorkspaceOnboardingReceiptAmbiguous,
  removeWorkspaceOnboardingReceipt,
} from './receiptStore.js';

export function recoverWorkspaceOnboardingReceipt(
  receiptPath: string,
  receipt: WorkspaceOnboardingPairReceipt,
): void {
  const root = receipt.workspaceRoot;
  const instruction = snapshotWorkspaceFile(
    root,
    INSTRUCTION_RELPATH,
    INSTRUCTION_MAX_BYTES,
  );
  const manifest = snapshotWorkspaceFile(
    root,
    MANIFEST_RELPATH,
    MANIFEST_MAX_BYTES,
  );
  const instructionBefore = snapshotMatchesEncodedSnapshot(
    instruction,
    receipt.instruction.before,
  );
  const manifestBefore = snapshotMatchesEncodedSnapshot(
    manifest,
    receipt.manifest.before,
  );
  const instructionAfter = receipt.instruction.after !== undefined &&
    snapshotMatchesVersion(instruction, receipt.instruction.after, true);
  const instructionStagedAtTarget = receipt.instruction.staged !== undefined &&
    snapshotMatchesVersion(instruction, receipt.instruction.staged, false);
  const instructionOwned = receipt.instruction.outcome === 'created'
    ? instructionAfter || instructionStagedAtTarget
    : receipt.instruction.outcome === undefined && instructionStagedAtTarget;
  const instructionUnchanged = receipt.instruction.outcome === 'unchanged' &&
    instructionAfter;
  const manifestAfter = receipt.manifest.after !== undefined &&
    snapshotMatchesVersion(manifest, receipt.manifest.after, true);
  const manifestDesired = (receipt.phase === 'manifest-committing' ||
      receipt.phase === 'manifest-written') &&
    snapshotMatchesDesired(manifest, receipt.manifest.desired);
  const manifestCommitted = manifestAfter || manifestDesired;

  if (manifestBefore) {
    if (instructionBefore || receipt.instruction.outcome === 'unchanged') {
      if (!removeOwnedStagedFile(receipt)) {
        markWorkspaceOnboardingReceiptAmbiguous(receiptPath, receipt);
        return;
      }
      removeWorkspaceOnboardingReceipt(receiptPath);
      return;
    }
    if (instructionOwned) {
      const ownedVersion = instructionAfter
        ? receipt.instruction.after!
        : receipt.instruction.staged!;
      if (restoreInstructionBefore(receipt, ownedVersion) &&
          removeOwnedStagedFile(receipt)) {
        removeWorkspaceOnboardingReceipt(receiptPath);
      } else {
        markWorkspaceOnboardingReceiptAmbiguous(receiptPath, receipt);
      }
      return;
    }
    markWorkspaceOnboardingReceiptAmbiguous(receiptPath, receipt);
    return;
  }

  if (manifestCommitted &&
      (instructionAfter || instructionStagedAtTarget || instructionUnchanged)) {
    if (removeOwnedStagedFile(receipt)) {
      removeWorkspaceOnboardingReceipt(receiptPath);
    } else {
      markWorkspaceOnboardingReceiptAmbiguous(receiptPath, receipt);
    }
    return;
  }

  markWorkspaceOnboardingReceiptAmbiguous(receiptPath, receipt);
}

function restoreInstructionBefore(
  receipt: WorkspaceOnboardingPairReceipt,
  ownedVersion: EncodedFileVersion,
): boolean {
  const before = receipt.instruction.before;
  if (!before.existed) {
    return removeOwnedInstruction(receipt.workspaceRoot, ownedVersion);
  }
  let beforeContents: Buffer;
  try {
    beforeContents = decodeSnapshotContents(before, INSTRUCTION_MAX_BYTES);
    writeWorkspaceFileAtomic(
      receipt.workspaceRoot,
      INSTRUCTION_RELPATH,
      beforeContents,
      {
        mode: before.mode,
        beforeCommit: () => {
          const current = snapshotWorkspaceFile(
            receipt.workspaceRoot,
            INSTRUCTION_RELPATH,
            INSTRUCTION_MAX_BYTES,
          );
          if (!snapshotMatchesVersion(current, ownedVersion, false)) {
            throw new Error(
              'Concurrent project instruction write detected during recovery.',
            );
          }
        },
      },
    );
    const restored = snapshotWorkspaceFile(
      receipt.workspaceRoot,
      INSTRUCTION_RELPATH,
      INSTRUCTION_MAX_BYTES,
    );
    return restored.existed && restored.mode === before.mode &&
      snapshotMatchesDesired(
        restored,
        { size: before.size!, sha256: before.sha256! },
      );
  } catch {
    return false;
  }
}

function removeOwnedInstruction(
  root: string,
  ownedVersion: EncodedFileVersion,
): boolean {
  let guard: WorkspaceFileParentGuard;
  try {
    guard = openWorkspaceFileParentGuard(root, INSTRUCTION_RELPATH);
  } catch {
    return false;
  }
  const quarantineName =
    `.AGENT.md.${process.pid}.${crypto.randomBytes(12).toString('hex')}` +
    '.onboarding-recovery';
  const quarantine = guard.siblingPath(quarantineName);
  try {
    guard.assertStable();
    const current = snapshotRegularFile(
      guard.accessTarget,
      INSTRUCTION_MAX_BYTES,
      'project instruction file',
    );
    if (!snapshotMatchesVersion(current, ownedVersion, false)) return false;
    fs.renameSync(guard.accessTarget, quarantine);
    guard.fsyncParent();
    guard.assertStable();
    const moved = snapshotRegularFile(
      quarantine,
      INSTRUCTION_MAX_BYTES,
      'project instruction recovery file',
    );
    if (!snapshotMatchesVersion(moved, ownedVersion, false)) {
      restoreQuarantinedFile(guard.accessTarget, quarantine, guard);
      return false;
    }
    const canonical = snapshotRegularFile(
      guard.accessTarget,
      INSTRUCTION_MAX_BYTES,
      'project instruction file',
    );
    const movedAgain = snapshotRegularFile(
      quarantine,
      INSTRUCTION_MAX_BYTES,
      'project instruction recovery file',
    );
    if (!snapshotMatchesVersion(movedAgain, ownedVersion, false)) return false;
    fs.unlinkSync(quarantine);
    guard.fsyncParent();
    guard.assertStable();
    // A concurrent creator at the canonical path is preserved. The transaction
    // only owns the quarantined inode proven by the receipt.
    void canonical;
    return true;
  } catch {
    return false;
  } finally {
    guard.close();
  }
}

function restoreQuarantinedFile(
  target: string,
  quarantine: string,
  guard: { assertStable(): void; fsyncParent(): void },
): void {
  try {
    guard.assertStable();
    if (snapshotRegularFile(
      target,
      INSTRUCTION_MAX_BYTES,
      'project instruction file',
    ).existed) {
      return;
    }
    fs.linkSync(quarantine, target);
    guard.fsyncParent();
    guard.assertStable();
    fs.unlinkSync(quarantine);
    guard.fsyncParent();
  } catch {
    // Preserve the quarantine when it cannot be safely restored.
  }
}

function removeOwnedStagedFile(
  receipt: WorkspaceOnboardingPairReceipt,
): boolean {
  const staged = receipt.instruction.staged;
  if (!staged) return true;
  let guard: WorkspaceFileParentGuard | undefined;
  try {
    guard = openWorkspaceFileParentGuard(
      receipt.workspaceRoot,
      INSTRUCTION_RELPATH,
    );
    if (path.dirname(staged.temporaryPath) !==
        path.dirname(guard.canonicalTarget)) {
      return false;
    }
    const accessTemporary = guard.siblingPath(
      path.basename(staged.temporaryPath),
    );
    guard.assertStable();
    const current = snapshotRegularFile(
      accessTemporary,
      INSTRUCTION_MAX_BYTES,
      'staged project instruction file',
    );
    if (!current.existed) return true;
    if (!snapshotMatchesVersion(current, staged, false)) return false;
    fs.unlinkSync(accessTemporary);
    guard.fsyncParent();
    guard.assertStable();
    return true;
  } catch {
    return false;
  } finally {
    guard?.close();
  }
}
