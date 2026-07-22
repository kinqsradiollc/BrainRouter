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
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs/atomicFile.js';
import {
  openWorkspaceFileParentGuard,
  writeWorkspaceFileAtomic,
  type WorkspaceFileParentGuard,
  type WorkspaceFileStagedVersion,
} from './fileWrite.js';

const INSTRUCTION_RELPATH = 'AGENT.md';
const MANIFEST_RELPATH = path.join('.brainrouter', 'workspace.json');
const INSTRUCTION_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_LIMIT = 16;

type PairPhase =
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

interface EncodedFileVersion {
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  sha256: string;
}

interface EncodedFileSnapshot {
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

interface DesiredFileVersion {
  size: number;
  sha256: string;
}

interface StagedFileVersion extends EncodedFileVersion {
  temporaryPath: string;
}

interface WorkspaceOnboardingPairReceipt {
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

interface ActivePairTransaction {
  transaction: WorkspaceOnboardingPairTransaction;
  receipt: WorkspaceOnboardingPairReceipt;
}

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
  const directory = receiptDirectory(root);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeReceiptDirectory(directory);
  const existing = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+\.[0-9a-f]{24}\.json$/.test(name));
  if (existing.length >= RECEIPT_LIMIT) {
    throw new Error('Too many pending workspace onboarding transactions; manual recovery is required.');
  }

  const receiptPath = path.join(directory, `${token}.json`);
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
    writeReceipt(receiptPath, receipt, true);
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
  const persisted = readReceipt(
    transaction.receiptPath,
    transaction.workspaceRoot,
    `${transaction.token}.json`,
  );
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(active.receipt)) {
    throw new Error('Workspace onboarding transaction receipt changed before completion.');
  }
  removeReceiptPath(transaction.receiptPath);
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
  const directory = receiptDirectory(root);
  try {
    assertSafeReceiptDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const entries = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+\.[0-9a-f]{24}\.json$/.test(name))
    .sort();
  if (entries.length > RECEIPT_LIMIT) {
    throw new Error('Too many pending workspace onboarding transactions; manual recovery is required.');
  }
  for (const name of entries) {
    const receiptPath = path.join(directory, name);
    const receipt = readReceipt(receiptPath, root, name);
    if (!receipt) {
      throw new Error(`Invalid workspace onboarding transaction receipt: ${receiptPath}`);
    }
    if (receipt.phase === 'ambiguous' || transactionOwnerIsActive(receipt.token)) continue;
    recoverReceipt(receiptPath, receipt);
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
  const directory = receiptDirectory(root);
  try {
    assertSafeReceiptDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const fileName = `${token}.json`;
  const receipt = readReceipt(path.join(directory, fileName), root, fileName);
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

function recoverReceipt(receiptPath: string, receipt: WorkspaceOnboardingPairReceipt): void {
  const root = receipt.workspaceRoot;
  const instruction = snapshotWorkspaceFile(root, INSTRUCTION_RELPATH, INSTRUCTION_MAX_BYTES);
  const manifest = snapshotWorkspaceFile(root, MANIFEST_RELPATH, MANIFEST_MAX_BYTES);
  const instructionBefore = snapshotMatchesEncodedSnapshot(instruction, receipt.instruction.before);
  const manifestBefore = snapshotMatchesEncodedSnapshot(manifest, receipt.manifest.before);
  const instructionAfter = receipt.instruction.after !== undefined &&
    snapshotMatchesVersion(instruction, receipt.instruction.after, true);
  const instructionStagedAtTarget = receipt.instruction.staged !== undefined &&
    snapshotMatchesVersion(instruction, receipt.instruction.staged, false);
  const instructionOwned = receipt.instruction.outcome === 'created'
    ? instructionAfter || instructionStagedAtTarget
    : receipt.instruction.outcome === undefined && instructionStagedAtTarget;
  const instructionUnchanged = receipt.instruction.outcome === 'unchanged' && instructionAfter;
  const manifestAfter = receipt.manifest.after !== undefined &&
    snapshotMatchesVersion(manifest, receipt.manifest.after, true);
  const manifestDesired = (receipt.phase === 'manifest-committing' || receipt.phase === 'manifest-written') &&
    snapshotMatchesDesired(manifest, receipt.manifest.desired);
  const manifestCommitted = manifestAfter || manifestDesired;

  if (manifestBefore) {
    if (instructionBefore || receipt.instruction.outcome === 'unchanged') {
      if (!removeOwnedStagedFile(receipt)) {
        markReceiptAmbiguous(receiptPath, receipt);
        return;
      }
      removeReceiptPath(receiptPath);
      return;
    }
    if (instructionOwned) {
      const ownedVersion = instructionAfter
        ? receipt.instruction.after!
        : receipt.instruction.staged!;
      if (restoreInstructionBefore(receipt, ownedVersion) && removeOwnedStagedFile(receipt)) {
        removeReceiptPath(receiptPath);
      } else {
        markReceiptAmbiguous(receiptPath, receipt);
      }
      return;
    }
    markReceiptAmbiguous(receiptPath, receipt);
    return;
  }

  if (manifestCommitted && (instructionAfter || instructionStagedAtTarget || instructionUnchanged)) {
    if (removeOwnedStagedFile(receipt)) removeReceiptPath(receiptPath);
    else markReceiptAmbiguous(receiptPath, receipt);
    return;
  }

  markReceiptAmbiguous(receiptPath, receipt);
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
    writeWorkspaceFileAtomic(receipt.workspaceRoot, INSTRUCTION_RELPATH, beforeContents, {
      mode: before.mode,
      beforeCommit: () => {
        const current = snapshotWorkspaceFile(
          receipt.workspaceRoot,
          INSTRUCTION_RELPATH,
          INSTRUCTION_MAX_BYTES,
        );
        if (!snapshotMatchesVersion(current, ownedVersion, false)) {
          throw new Error('Concurrent project instruction write detected during recovery.');
        }
      },
    });
    const restored = snapshotWorkspaceFile(
      receipt.workspaceRoot,
      INSTRUCTION_RELPATH,
      INSTRUCTION_MAX_BYTES,
    );
    return restored.existed && restored.mode === before.mode &&
      snapshotMatchesDesired(restored, { size: before.size!, sha256: before.sha256! });
  } catch {
    return false;
  }
}

function removeOwnedInstruction(root: string, ownedVersion: EncodedFileVersion): boolean {
  let guard: WorkspaceFileParentGuard;
  try {
    guard = openWorkspaceFileParentGuard(root, INSTRUCTION_RELPATH);
  } catch {
    return false;
  }
  const quarantineName = `.AGENT.md.${process.pid}.${crypto.randomBytes(12).toString('hex')}.onboarding-recovery`;
  const quarantine = guard.siblingPath(quarantineName);
  try {
    guard.assertStable();
    const current = snapshotRegularFile(guard.accessTarget, INSTRUCTION_MAX_BYTES, 'project instruction file');
    if (!snapshotMatchesVersion(current, ownedVersion, false)) return false;
    fs.renameSync(guard.accessTarget, quarantine);
    guard.fsyncParent();
    guard.assertStable();
    const moved = snapshotRegularFile(quarantine, INSTRUCTION_MAX_BYTES, 'project instruction recovery file');
    if (!snapshotMatchesVersion(moved, ownedVersion, false)) {
      restoreQuarantinedFile(guard.accessTarget, quarantine, guard);
      return false;
    }
    const canonical = snapshotRegularFile(guard.accessTarget, INSTRUCTION_MAX_BYTES, 'project instruction file');
    const movedAgain = snapshotRegularFile(quarantine, INSTRUCTION_MAX_BYTES, 'project instruction recovery file');
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
    if (snapshotRegularFile(target, INSTRUCTION_MAX_BYTES, 'project instruction file').existed) return;
    fs.linkSync(quarantine, target);
    guard.fsyncParent();
    guard.assertStable();
    fs.unlinkSync(quarantine);
    guard.fsyncParent();
  } catch {
    // Preserve the quarantine when it cannot be safely restored.
  }
}

function removeOwnedStagedFile(receipt: WorkspaceOnboardingPairReceipt): boolean {
  const staged = receipt.instruction.staged;
  if (!staged) return true;
  let guard: WorkspaceFileParentGuard | undefined;
  try {
    guard = openWorkspaceFileParentGuard(receipt.workspaceRoot, INSTRUCTION_RELPATH);
    if (path.dirname(staged.temporaryPath) !== path.dirname(guard.canonicalTarget)) return false;
    const accessTemporary = guard.siblingPath(path.basename(staged.temporaryPath));
    guard.assertStable();
    const current = snapshotRegularFile(accessTemporary, INSTRUCTION_MAX_BYTES, 'staged project instruction file');
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
  writeReceipt(transaction.receiptPath, next);
  active.receipt = next;
}

function normalizeProvidedSnapshot(
  snapshot: WorkspaceOnboardingFileSnapshot,
  maxBytes: number,
  label: string,
): WorkspaceOnboardingFileSnapshot {
  if (!snapshot.existed) return { existed: false };
  if (!validFilesystemMode(snapshot.mode) || !validIdentityNumber(snapshot.dev) ||
      !validIdentityNumber(snapshot.ino) || !validSize(snapshot.size, maxBytes) ||
      !validTimestamp(snapshot.mtimeMs) || !validTimestamp(snapshot.ctimeMs) ||
      !Buffer.isBuffer(snapshot.contents) || snapshot.contents.length !== snapshot.size) {
    throw new Error(`Invalid ${label} snapshot.`);
  }
  return {
    existed: true,
    mode: snapshot.mode! & 0o777,
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
    ctimeMs: snapshot.ctimeMs,
    contents: Buffer.from(snapshot.contents),
  };
}

function desiredVersion(
  contents: string | Buffer,
  maxBytes: number,
  label: string,
): DesiredFileVersion {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return { size: bytes.length, sha256: sha256(bytes) };
}

function encodeSnapshot(snapshot: WorkspaceOnboardingFileSnapshot): EncodedFileSnapshot {
  if (!snapshot.existed) return { existed: false };
  return {
    existed: true,
    ...encodeVersion(snapshot),
    contentsBase64: snapshot.contents!.toString('base64'),
  };
}

function encodeVersion(snapshot: WorkspaceOnboardingFileSnapshot): EncodedFileVersion {
  if (!snapshot.existed || !snapshot.contents) throw new Error('Cannot encode an absent workspace file.');
  return {
    mode: snapshot.mode! & 0o777,
    dev: snapshot.dev!,
    ino: snapshot.ino!,
    size: snapshot.size!,
    mtimeMs: snapshot.mtimeMs!,
    ctimeMs: snapshot.ctimeMs,
    sha256: sha256(snapshot.contents),
  };
}

function encodeStagedVersion(staged: WorkspaceFileStagedVersion): StagedFileVersion {
  if (!validMode(staged.mode) || !validIdentityNumber(staged.dev) ||
      !validIdentityNumber(staged.ino) || !validSize(staged.size, INSTRUCTION_MAX_BYTES) ||
      !validTimestamp(staged.mtimeMs) || !validHash(staged.sha256)) {
    throw new Error('Invalid staged project instruction version.');
  }
  return {
    temporaryPath: staged.temporaryPath,
    mode: staged.mode & 0o777,
    dev: staged.dev,
    ino: staged.ino,
    size: staged.size,
    mtimeMs: staged.mtimeMs,
    sha256: staged.sha256,
  };
}

function snapshotWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
): WorkspaceOnboardingFileSnapshot {
  let guard: WorkspaceFileParentGuard;
  try {
    guard = openWorkspaceFileParentGuard(workspaceRoot, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
  try {
    guard.assertStable();
    const snapshot = snapshotRegularFile(guard.accessTarget, maxBytes, relativePath);
    guard.assertStable();
    return snapshot;
  } finally {
    guard.close();
  }
}

function snapshotWorkspaceSibling(
  workspaceRoot: string,
  relativePath: string,
  siblingPath: string,
  maxBytes: number,
): WorkspaceOnboardingFileSnapshot {
  const guard = openWorkspaceFileParentGuard(workspaceRoot, relativePath);
  try {
    if (path.dirname(siblingPath) !== path.dirname(guard.canonicalTarget)) {
      throw new Error('Unexpected workspace sibling path.');
    }
    guard.assertStable();
    const snapshot = snapshotRegularFile(
      guard.siblingPath(path.basename(siblingPath)),
      maxBytes,
      'workspace sibling file',
    );
    guard.assertStable();
    return snapshot;
  } finally {
    guard.close();
  }
}

function snapshotRegularFile(
  target: string,
  maxBytes: number,
  label: string,
): WorkspaceOnboardingFileSnapshot {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new Error(`Unsafe ${label}: ${target}`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFilesystemEntry(pathStat, opened) || opened.size > maxBytes) {
      throw new Error(`Unsafe ${label}: ${target}`);
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (read <= 0) throw new Error(`${label} changed while reading: ${target}`);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameStableFile(opened, after) || afterPath.isSymbolicLink() || !afterPath.isFile() ||
        !sameStableFile(after, afterPath)) {
      throw new Error(`${label} changed while reading: ${target}`);
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

function snapshotMatchesEncodedSnapshot(
  snapshot: WorkspaceOnboardingFileSnapshot,
  expected: EncodedFileSnapshot,
): boolean {
  if (snapshot.existed !== expected.existed) return false;
  if (!snapshot.existed) return true;
  return snapshotMatchesVersion(snapshot, expected as EncodedFileVersion, true);
}

function snapshotMatchesVersion(
  snapshot: WorkspaceOnboardingFileSnapshot,
  expected: EncodedFileVersion,
  compareCtime: boolean,
): boolean {
  return snapshot.existed && snapshot.mode === expected.mode &&
    snapshot.dev === expected.dev && snapshot.ino === expected.ino &&
    snapshot.size === expected.size && snapshot.mtimeMs === expected.mtimeMs &&
    (!compareCtime || expected.ctimeMs === undefined || snapshot.ctimeMs === expected.ctimeMs) &&
    sha256(snapshot.contents!) === expected.sha256;
}

function snapshotMatchesDesired(
  snapshot: WorkspaceOnboardingFileSnapshot,
  desired: DesiredFileVersion,
): boolean {
  return snapshot.existed && snapshot.size === desired.size && sha256(snapshot.contents!) === desired.sha256;
}

function decodeSnapshotContents(snapshot: EncodedFileSnapshot, maxBytes: number): Buffer {
  if (!snapshot.existed || typeof snapshot.contentsBase64 !== 'string') {
    throw new Error('Workspace onboarding receipt has no restorable contents.');
  }
  const contents = Buffer.from(snapshot.contentsBase64, 'base64');
  if (contents.length > maxBytes || contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
    throw new Error('Workspace onboarding receipt contents are invalid.');
  }
  return contents;
}

function writeReceipt(
  receiptPath: string,
  receipt: WorkspaceOnboardingPairReceipt,
  exclusive = false,
): void {
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(serialized) > RECEIPT_MAX_BYTES) {
    throw new Error(`Workspace onboarding transaction receipt exceeds ${RECEIPT_MAX_BYTES} bytes.`);
  }
  writeFileAtomic(receiptPath, serialized, { mode: 0o600, exclusive });
}

function readReceipt(
  receiptPath: string,
  workspaceRoot: string,
  fileName: string,
): WorkspaceOnboardingPairReceipt | undefined {
  let parsed: unknown;
  try {
    const snapshot = snapshotRegularFile(receiptPath, RECEIPT_MAX_BYTES, 'workspace onboarding receipt');
    if (!snapshot.existed) return undefined;
    parsed = JSON.parse(snapshot.contents!.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Partial<WorkspaceOnboardingPairReceipt>;
  if (receipt.version !== 1 || !isPairPhase(receipt.phase) ||
      receipt.workspaceRoot !== workspaceRoot || typeof receipt.token !== 'string' ||
      fileName !== `${receipt.token}.json` || !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.token) ||
      !validReceiptInstruction(receipt.instruction, workspaceRoot) ||
      !validReceiptManifest(receipt.manifest) ||
      !validReceiptPhaseState(receipt as WorkspaceOnboardingPairReceipt)) {
    return undefined;
  }
  return receipt as WorkspaceOnboardingPairReceipt;
}

function validReceiptInstruction(
  value: WorkspaceOnboardingPairReceipt['instruction'] | undefined,
  workspaceRoot: string,
): boolean {
  if (!value || !validEncodedSnapshot(value.before, INSTRUCTION_MAX_BYTES) ||
      !validDesiredVersion(value.desired, INSTRUCTION_MAX_BYTES)) return false;
  if (value.outcome !== undefined && value.outcome !== 'created' && value.outcome !== 'unchanged') return false;
  if (value.after !== undefined && !validEncodedVersion(value.after, INSTRUCTION_MAX_BYTES)) return false;
  if (value.staged !== undefined) {
    const expectedDirectory = path.join(workspaceRoot);
    if (!validEncodedVersion(value.staged, INSTRUCTION_MAX_BYTES) ||
        path.dirname(value.staged.temporaryPath) !== expectedDirectory ||
        !/^\.AGENT\.md\.[0-9]+\.[0-9a-f]{24}\.tmp$/.test(path.basename(value.staged.temporaryPath))) {
      return false;
    }
  }
  return true;
}

function validReceiptManifest(
  value: WorkspaceOnboardingPairReceipt['manifest'] | undefined,
): boolean {
  return !!value && validEncodedSnapshot(value.before, MANIFEST_MAX_BYTES) &&
    validDesiredVersion(value.desired, MANIFEST_MAX_BYTES) &&
    (value.after === undefined || validEncodedVersion(value.after, MANIFEST_MAX_BYTES));
}

function validReceiptPhaseState(receipt: WorkspaceOnboardingPairReceipt): boolean {
  const instructionEmpty = receipt.instruction.outcome === undefined && receipt.instruction.after === undefined;
  const instructionRecorded = receipt.instruction.outcome !== undefined && receipt.instruction.after !== undefined;
  if (!instructionEmpty && !instructionRecorded) return false;
  if (receipt.phase === 'ambiguous') return true;
  if (receipt.phase === 'prepared') {
    return receipt.instruction.staged === undefined && instructionEmpty && receipt.manifest.after === undefined;
  }
  if (receipt.phase === 'instruction-committing') {
    return instructionEmpty && receipt.manifest.after === undefined;
  }
  if (receipt.phase === 'instruction-written' || receipt.phase === 'manifest-committing') {
    return instructionRecorded && receipt.manifest.after === undefined;
  }
  return instructionRecorded && receipt.manifest.after !== undefined;
}

function validEncodedSnapshot(value: EncodedFileSnapshot, maxBytes: number): boolean {
  if (!value || typeof value !== 'object' || typeof value.existed !== 'boolean') return false;
  if (!value.existed) return true;
  if (!validEncodedVersion(value as EncodedFileVersion, maxBytes) ||
      typeof value.contentsBase64 !== 'string' || value.contentsBase64.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    return false;
  }
  try {
    const contents = Buffer.from(value.contentsBase64, 'base64');
    return contents.length === value.size && sha256(contents) === value.sha256;
  } catch {
    return false;
  }
}

function validEncodedVersion(value: EncodedFileVersion, maxBytes: number): boolean {
  return !!value && typeof value === 'object' && validMode(value.mode) &&
    validIdentityNumber(value.dev) && validIdentityNumber(value.ino) &&
    validSize(value.size, maxBytes) && validTimestamp(value.mtimeMs) &&
    (value.ctimeMs === undefined || validTimestamp(value.ctimeMs)) && validHash(value.sha256);
}

function validDesiredVersion(value: DesiredFileVersion, maxBytes: number): boolean {
  return !!value && typeof value === 'object' && validSize(value.size, maxBytes) && validHash(value.sha256);
}

function isPairPhase(value: unknown): value is PairPhase {
  return value === 'prepared' || value === 'instruction-committing' ||
    value === 'instruction-written' || value === 'manifest-committing' ||
    value === 'manifest-written' || value === 'ambiguous';
}

function validMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

function validFilesystemMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validIdentityNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSize(value: unknown, maxBytes: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maxBytes;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function receiptDirectory(workspaceRoot: string): string {
  const configuredHome = process.env.BRAINROUTER_HOME?.trim();
  const brainrouterHome = configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), '.brainrouter');
  const workspaceKey = crypto.createHash('sha256').update(fs.realpathSync(workspaceRoot)).digest('hex').slice(0, 32);
  return path.join(brainrouterHome, 'transactions', 'workspace-onboarding', workspaceKey);
}

function assertSafeReceiptDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe workspace onboarding transaction directory: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe workspace onboarding transaction directory permissions: ${directory}`);
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && stat.uid !== currentUser) {
    throw new Error(`Unsafe workspace onboarding transaction directory owner: ${directory}`);
  }
}

function markReceiptAmbiguous(receiptPath: string, receipt: WorkspaceOnboardingPairReceipt): void {
  if (receipt.phase !== 'ambiguous') writeReceipt(receiptPath, { ...receipt, phase: 'ambiguous' });
}

function transactionOwnerIsActive(token: string): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return activePairTransactions.has(token);
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeReceiptPath(receiptPath: string): void {
  try {
    fs.unlinkSync(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fsyncDirectory(path.dirname(receiptPath));
}

function sha256(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFilesystemEntry(left, right) && (left.mode & 0o777) === (right.mode & 0o777) &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}
