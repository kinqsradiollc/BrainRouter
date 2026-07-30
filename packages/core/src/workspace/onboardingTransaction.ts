/**
 * Recoverable two-file workspace onboarding coordinator (0.4.17).
 *
 * Treats project instructions and `.brainrouter/workspace.json` as one logical
 * commit even though the filesystem cannot replace both atomically. Durable,
 * bounded receipts record exact before, desired, and committed versions;
 * recovery changes only files attributable to a dead transaction and leaves
 * ambiguous state untouched for manual recovery. Receipts live in an
 * owner-only directory and use randomized, exclusive, no-follow atomic staging.
 * Workspace mutations use a descriptor-anchored parent guard with fixed or
 * cryptographically random sibling names, never caller-provided path segments.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type WorkspaceFileStagedVersion } from './fileWrite.js';
import {
  INSTRUCTION_MAX_BYTES,
  INSTRUCTION_RELPATH,
  MANIFEST_MAX_BYTES,
  MANIFEST_RELPATH,
  type ActivePairTransaction,
  type PairPhase,
  type WorkspaceOnboardingFileSnapshot,
  type WorkspaceOnboardingManifestClaimFingerprint,
  type WorkspaceOnboardingManifestReplacementFingerprint,
  type WorkspaceOnboardingPairReceipt,
  type WorkspaceOnboardingPairTransaction,
} from './onboardingTransaction/contracts.js';
import {
  desiredVersion,
  encodeSnapshot,
  encodeStagedVersion,
  encodeVersion,
  normalizeProvidedSnapshot,
  snapshotMatchesVersion,
  snapshotsAreExact,
  snapshotWorkspaceFile,
  snapshotWorkspaceSibling,
} from './onboardingTransaction/fileSnapshots.js';
import {
  listWorkspaceOnboardingReceipts,
  prepareWorkspaceOnboardingReceiptPath,
  readWorkspaceOnboardingReceipt,
  readWorkspaceOnboardingReceiptForToken,
  removeWorkspaceOnboardingReceipt,
  workspaceOnboardingTransactionOwnerIsActive,
  writeWorkspaceOnboardingReceipt,
} from './onboardingTransaction/receiptStore.js';
import {
  recoverWorkspaceOnboardingReceipt,
} from './onboardingTransaction/receiptRecovery.js';

export type {
  WorkspaceOnboardingFileSnapshot,
  WorkspaceOnboardingManifestClaimFingerprint,
  WorkspaceOnboardingManifestReplacementFingerprint,
  WorkspaceOnboardingPairTransaction,
} from './onboardingTransaction/contracts.js';

const activePairTransactions = new Map<string, ActivePairTransaction>();

/** Persist the complete pre-state before either workspace file may change. */
export function beginWorkspaceOnboardingPairTransaction(
  workspaceRoot: string,
  input: {
    manifestBefore: WorkspaceOnboardingFileSnapshot;
    manifestDesired: string | Buffer;
    instructionBefore: WorkspaceOnboardingFileSnapshot;
    instructionDesired: string | Buffer;
  },
): WorkspaceOnboardingPairTransaction {
  const root = fs.realpathSync(workspaceRoot);
  const manifestBefore = normalizeProvidedSnapshot(
    input.manifestBefore,
    MANIFEST_MAX_BYTES,
    'workspace manifest',
  );
  const instructionBefore = normalizeProvidedSnapshot(
    input.instructionBefore,
    INSTRUCTION_MAX_BYTES,
    'project instruction file',
  );
  if (!snapshotsAreExact(manifestBefore, snapshotWorkspaceFile(root, MANIFEST_RELPATH, MANIFEST_MAX_BYTES)) ||
      !snapshotsAreExact(instructionBefore, snapshotWorkspaceFile(root, INSTRUCTION_RELPATH, INSTRUCTION_MAX_BYTES))) {
    throw new Error('Workspace files changed before the onboarding transaction was prepared.');
  }

  const token = `${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
  const receiptPath = prepareWorkspaceOnboardingReceiptPath(root, token);
  const transaction = { workspaceRoot: root, token, receiptPath };
  const receipt: WorkspaceOnboardingPairReceipt = {
    version: 1,
    phase: 'prepared',
    workspaceRoot: root,
    token,
    instruction: {
      before: encodeSnapshot(instructionBefore),
      desired: desiredVersion(input.instructionDesired, INSTRUCTION_MAX_BYTES, 'project instruction file'),
    },
    manifest: {
      before: encodeSnapshot(manifestBefore),
      desired: desiredVersion(input.manifestDesired, MANIFEST_MAX_BYTES, 'workspace manifest'),
    },
  };
  activePairTransactions.set(token, { transaction, receipt });
  try {
    writeWorkspaceOnboardingReceipt(receiptPath, receipt, true);
  } catch (error) {
    activePairTransactions.delete(token);
    throw error;
  }
  return transaction;
}

export function markWorkspaceOnboardingInstructionCommitting(
  transaction: WorkspaceOnboardingPairTransaction,
): void {
  updateActiveReceipt(transaction, ['prepared'], (receipt) => ({
    ...receipt,
    phase: 'instruction-committing',
  }));
}

export function recordWorkspaceOnboardingInstructionStaged(
  transaction: WorkspaceOnboardingPairTransaction,
  staged: WorkspaceFileStagedVersion,
): void {
  // The writer creates this sibling atomically with a random nonce. Re-prove
  // both its canonical name and exact inode/content identity before journaling.
  const root = fs.realpathSync(transaction.workspaceRoot);
  const target = path.join(root, INSTRUCTION_RELPATH);
  if (path.dirname(staged.temporaryPath) !== path.dirname(target) ||
      !/^\.AGENT\.md\.[0-9]+\.[0-9a-f]{24}\.tmp$/.test(path.basename(staged.temporaryPath))) {
    throw new Error('Unexpected staged project instruction path.');
  }
  const encoded = encodeStagedVersion(staged);
  const observed = snapshotWorkspaceSibling(root, INSTRUCTION_RELPATH, staged.temporaryPath, INSTRUCTION_MAX_BYTES);
  if (!snapshotMatchesVersion(observed, encoded, false)) {
    throw new Error('Staged project instruction file changed before it was recorded.');
  }
  updateActiveReceipt(transaction, ['instruction-committing'], (receipt) => ({
    ...receipt,
    instruction: { ...receipt.instruction, staged: encoded },
  }));
}

export function recordWorkspaceOnboardingInstructionWritten(
  transaction: WorkspaceOnboardingPairTransaction,
  outcome: 'created' | 'unchanged',
  after: WorkspaceOnboardingFileSnapshot,
): void {
  const normalized = normalizeProvidedSnapshot(after, INSTRUCTION_MAX_BYTES, 'project instruction file');
  if (!normalized.existed ||
      !snapshotsAreExact(
        normalized,
        snapshotWorkspaceFile(transaction.workspaceRoot, INSTRUCTION_RELPATH, INSTRUCTION_MAX_BYTES),
      )) {
    throw new Error('Project instruction file changed before its commit was recorded.');
  }
  updateActiveReceipt(transaction, ['instruction-committing'], (receipt) => ({
    ...receipt,
    phase: 'instruction-written',
    instruction: { ...receipt.instruction, outcome, after: encodeVersion(normalized) },
  }));
}

export function markWorkspaceOnboardingManifestCommitting(
  transaction: WorkspaceOnboardingPairTransaction,
): void {
  updateActiveReceipt(transaction, ['instruction-written'], (receipt) => ({
    ...receipt,
    phase: 'manifest-committing',
  }));
}

export function recordWorkspaceOnboardingManifestWritten(
  transaction: WorkspaceOnboardingPairTransaction,
  after: WorkspaceOnboardingFileSnapshot,
): void {
  const normalized = normalizeProvidedSnapshot(after, MANIFEST_MAX_BYTES, 'workspace manifest');
  if (!normalized.existed ||
      !snapshotsAreExact(
        normalized,
        snapshotWorkspaceFile(transaction.workspaceRoot, MANIFEST_RELPATH, MANIFEST_MAX_BYTES),
      )) {
    throw new Error('Workspace manifest changed before its commit was recorded.');
  }
  updateActiveReceipt(transaction, ['manifest-committing'], (receipt) => ({
    ...receipt,
    phase: 'manifest-written',
    manifest: { ...receipt.manifest, after: encodeVersion(normalized) },
  }));
}

/** Retire durable state after either a complete commit or a verified rollback. */
export function completeWorkspaceOnboardingPairTransaction(
  transaction: WorkspaceOnboardingPairTransaction,
): void {
  const active = activeTransaction(transaction);
  const persisted = readWorkspaceOnboardingReceipt(
    transaction.receiptPath,
    transaction.workspaceRoot,
    `${transaction.token}.json`,
  );
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(active.receipt)) {
    throw new Error('Workspace onboarding transaction receipt changed before completion.');
  }
  removeWorkspaceOnboardingReceipt(transaction.receiptPath);
}

/** Mark only the in-process owner inactive; recovery state is deliberately retained. */
export function endWorkspaceOnboardingPairTransaction(
  transaction: WorkspaceOnboardingPairTransaction,
): void {
  const active = activePairTransactions.get(transaction.token);
  if (active?.transaction.receiptPath === transaction.receiptPath) {
    activePairTransactions.delete(transaction.token);
  }
}

/** Recover dead pair transactions before the shared manifest read chokepoint. */
export function recoverInterruptedWorkspaceOnboardingPair(workspaceRoot: string): void {
  const root = fs.realpathSync(workspaceRoot);
  for (const stored of listWorkspaceOnboardingReceipts(root)) {
    if (stored.receipt.phase === 'ambiguous' ||
        transactionOwnerIsActive(stored.receipt.token)) {
      continue;
    }
    recoverWorkspaceOnboardingReceipt(stored.receiptPath, stored.receipt);
  }
}

/**
 * Prove that a post-write manifest belongs to a durable pair transaction. The
 * manifest claim recovery runs before pair recovery, so it uses this read-only
 * proof to retire the old inode while leaving the coordinator available to
 * accept or roll back the complete pair.
 */
export function workspaceOnboardingPairOwnsManifestReplacement(
  workspaceRoot: string,
  token: string,
  before: WorkspaceOnboardingManifestClaimFingerprint,
  replacement: WorkspaceOnboardingManifestReplacementFingerprint,
): boolean {
  if (!/^[0-9]+\.[0-9a-f]{24}$/.test(token)) return false;
  const root = fs.realpathSync(workspaceRoot);
  const receipt = readWorkspaceOnboardingReceiptForToken(root, token);
  if (!receipt || transactionOwnerIsActive(receipt.token) ||
      (receipt.phase !== 'manifest-committing' && receipt.phase !== 'manifest-written')) {
    return false;
  }
  const expected = receipt.manifest.before;
  return expected.existed === true &&
    expected.mode === before.mode && expected.dev === before.dev && expected.ino === before.ino &&
    expected.size === before.size && expected.mtimeMs === before.mtimeMs && expected.sha256 === before.sha256 &&
    receipt.manifest.desired.size === replacement.size &&
    receipt.manifest.desired.sha256 === replacement.sha256;
}

function activeTransaction(transaction: WorkspaceOnboardingPairTransaction): ActivePairTransaction {
  const active = activePairTransactions.get(transaction.token);
  if (!active || active.transaction.workspaceRoot !== transaction.workspaceRoot ||
      active.transaction.receiptPath !== transaction.receiptPath) {
    throw new Error('Workspace onboarding transaction is not active.');
  }
  return active;
}

function updateActiveReceipt(
  transaction: WorkspaceOnboardingPairTransaction,
  allowedPhases: PairPhase[],
  update: (receipt: WorkspaceOnboardingPairReceipt) => WorkspaceOnboardingPairReceipt,
): void {
  const active = activeTransaction(transaction);
  if (!allowedPhases.includes(active.receipt.phase)) {
    throw new Error(`Unexpected workspace onboarding transaction phase: ${active.receipt.phase}`);
  }
  const next = update(active.receipt);
    writeWorkspaceOnboardingReceipt(transaction.receiptPath, next);
  active.receipt = next;
}

function transactionOwnerIsActive(token: string): boolean {
  return workspaceOnboardingTransactionOwnerIsActive(
    token,
    (candidate) => activePairTransactions.has(candidate),
  );
}
