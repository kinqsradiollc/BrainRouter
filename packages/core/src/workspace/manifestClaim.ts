/**
 * Crash-recoverable ownership claims for workspace manifest replacement (0.4.17).
 *
 * Moving an existing manifest aside makes replacement rollback possible, but a
 * process can die between filesystem operations; durable receipts prove which
 * inode and desired replacement the transaction owns. Recovery is bounded,
 * never disturbs live owners, and fails closed when ownership is ambiguous.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs/atomicFile.js';
import { openWorkspaceFileParentGuard } from './fileWrite.js';
import { workspaceOnboardingPairOwnsManifestReplacement } from './onboardingTransaction.js';

export interface WorkspaceManifestClaimExpected {
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  contents: Buffer;
}

export interface WorkspaceManifestClaimTransaction {
  workspaceRoot: string;
  target: string;
  claim: string;
  token: string;
  receiptPath: string;
}

export interface WorkspaceManifestClaimOptions {
  desired: string | Buffer;
  onboardingPairToken?: string;
}

interface WorkspaceManifestClaimReceipt {
  version: 1;
  phase: 'prepared' | 'ambiguous';
  target: string;
  claim: string;
  token: string;
  desired?: {
    size: number;
    sha256: string;
  };
  onboardingPairToken?: string;
  expected: {
    mode: number;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    sha256: string;
  };
}

interface RegularFileSnapshot {
  existed: boolean;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  contents?: Buffer;
}

const RECEIPT_MAX_BYTES = 16 * 1024;
const RECEIPT_LIMIT = 64;
const activeClaimTokens = new Set<string>();

/**
 * Persist ownership before a manifest is hidden at its claim path. The caller
 * must verify this receipt immediately before rename and always end the active
 * transaction in a finally block.
 */
export function beginWorkspaceManifestClaim(
  workspaceRoot: string,
  target: string,
  expected: WorkspaceManifestClaimExpected,
  options?: WorkspaceManifestClaimOptions,
): WorkspaceManifestClaimTransaction {
  const root = fs.realpathSync(workspaceRoot);
  const canonicalTarget = path.join(root, '.brainrouter', 'workspace.json');
  if (target !== canonicalTarget) {
    throw new Error(`Unexpected workspace manifest transaction target: ${target}`);
  }
  const token = `${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
  const claim = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${token}.claim`,
  );
  const directory = receiptDirectory(root);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(directory, `${token}.json`);
  const desired = options
    ? Buffer.isBuffer(options.desired) ? options.desired : Buffer.from(options.desired)
    : undefined;
  if (desired && desired.length > 256 * 1024) {
    throw new Error('Workspace manifest desired version exceeds the recovery limit.');
  }
  if (options?.onboardingPairToken !== undefined &&
      !/^[0-9]+\.[0-9a-f]{24}$/.test(options.onboardingPairToken)) {
    throw new Error('Invalid workspace onboarding transaction token.');
  }
  const receipt: WorkspaceManifestClaimReceipt = {
    version: 1,
    phase: 'prepared',
    target,
    claim,
    token,
    ...(desired ? { desired: { size: desired.length, sha256: sha256(desired) } } : {}),
    ...(options?.onboardingPairToken
      ? { onboardingPairToken: options.onboardingPairToken }
      : {}),
    expected: {
      mode: expected.mode,
      dev: expected.dev,
      ino: expected.ino,
      size: expected.size,
      mtimeMs: expected.mtimeMs,
      sha256: sha256(expected.contents),
    },
  };
  activeClaimTokens.add(token);
  try {
    writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
      exclusive: true,
    });
  } catch (error) {
    activeClaimTokens.delete(token);
    throw error;
  }
  return { workspaceRoot: root, target, claim, token, receiptPath };
}

/** Fail closed if the durable ownership receipt changed before the rename. */
export function assertWorkspaceManifestClaimReceipt(
  transaction: WorkspaceManifestClaimTransaction,
): void {
  const receipt = readReceipt(
    transaction.receiptPath,
    transaction.target,
    `${transaction.token}.json`,
  );
  if (!receipt || receipt.phase !== 'prepared' ||
      receipt.claim !== transaction.claim || receipt.token !== transaction.token) {
    throw new Error('Workspace manifest transaction receipt changed before claim.');
  }
}

/** Remove the exact transaction receipt after its claim is restored or retired. */
export function removeWorkspaceManifestClaimReceipt(
  transaction: WorkspaceManifestClaimTransaction,
): void {
  assertWorkspaceManifestClaimReceipt(transaction);
  fs.unlinkSync(transaction.receiptPath);
  fsyncDirectory(path.dirname(transaction.receiptPath));
}

/** Mark the in-process owner inactive; this never removes durable recovery state. */
export function endWorkspaceManifestClaim(
  transaction: WorkspaceManifestClaimTransaction,
): void {
  activeClaimTokens.delete(transaction.token);
}

/**
 * Recover claims left by dead transactions before every shared manifest read.
 * A live owner is never disturbed, including the receipt-before-rename window
 * and the replacement-created-before-cleanup window.
 */
export function recoverInterruptedWorkspaceManifestClaim(workspaceRoot: string): void {
  const root = fs.realpathSync(workspaceRoot);
  const directory = receiptDirectory(root);
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Unsafe workspace manifest transaction directory: ${directory}`);
  }

  const entries = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+\.[0-9a-f]{24}\.json$/.test(name))
    .sort();
  if (entries.length > RECEIPT_LIMIT) {
    throw new Error('Too many pending workspace manifest transactions; manual recovery is required.');
  }

  let guard;
  try {
    guard = openWorkspaceFileParentGuard(root, path.join('.brainrouter', 'workspace.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const target = guard.canonicalTarget;
    for (const name of entries) {
      const receiptPath = path.join(directory, name);
      const receipt = readReceipt(receiptPath, target, name);
      if (!receipt || transactionOwnerIsActive(receipt.token)) continue;
      const claim = guard.siblingPath(path.basename(receipt.claim));
      guard.assertStable();
      const claimed = snapshotRegularFile(claim, 256 * 1024, 'workspace manifest claim');
      const current = snapshotRegularFile(guard.accessTarget, 256 * 1024, 'workspace manifest');
      guard.assertStable();

      if (!claimed.existed) {
        if (current.existed) removeReceiptPath(receiptPath);
        continue;
      }
      if (!snapshotMatchesReceipt(claimed, receipt)) continue;

      if (current.existed && manifestClaimOwnsReplacement(root, receipt, claimed, current)) {
        guard.assertStable();
        unlinkIfPresent(claim);
        guard.fsyncParent();
        guard.assertStable();
        removeReceiptPath(receiptPath);
        continue;
      }
      if (receipt.phase === 'ambiguous') continue;

      if (current.existed) {
        if (snapshotsAreExact(claimed, current)) {
          // Recovery previously linked this exact inode back to the canonical
          // path and died before retiring the extra name.
          guard.assertStable();
          unlinkIfPresent(claim);
          guard.fsyncParent();
          guard.assertStable();
          removeReceiptPath(receiptPath);
          continue;
        }
        // The canonical path may be an unowned partial or a concurrent write.
        // Without a durable committed-replacement hash there is no proof that
        // deleting the old claim is safe, so preserve both for manual recovery.
        writeReceipt(receiptPath, { ...receipt, phase: 'ambiguous' });
        continue;
      }

      guard.assertStable();
      try {
        fs.linkSync(claim, guard.accessTarget);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOENT') throw error;

        // ADR-021 (0.4.17) — another recoverer may have linked the owned inode and retired its
        // claim between our snapshots and this syscall. Accept only that exact
        // progress; a different creator is ambiguous and must win unchanged.
        guard.assertStable();
        const racedTarget = snapshotRegularFile(
          guard.accessTarget,
          256 * 1024,
          'workspace manifest',
        );
        if (!snapshotsAreSameVersion(claimed, racedTarget)) {
          if (code === 'EEXIST') {
            writeReceipt(receiptPath, { ...receipt, phase: 'ambiguous' });
          }
          continue;
        }
      }
      guard.fsyncParent();
      guard.assertStable();
      const claimAfterLink = snapshotRegularFile(claim, 256 * 1024, 'workspace manifest claim');
      const restored = snapshotRegularFile(guard.accessTarget, 256 * 1024, 'workspace manifest');
      if (!snapshotsAreSameVersion(claimed, restored) ||
          (claimAfterLink.existed && !snapshotsAreSameVersion(claimAfterLink, restored))) {
        throw new Error(`Workspace manifest claim could not be restored safely: ${receipt.claim}`);
      }
      guard.assertStable();
      unlinkIfPresent(claim);
      guard.fsyncParent();
      guard.assertStable();
      removeReceiptPath(receiptPath);
    }
  } finally {
    guard.close();
  }
}

function readReceipt(
  receiptPath: string,
  target: string,
  fileName: string,
): WorkspaceManifestClaimReceipt | undefined {
  let parsed: unknown;
  try {
    const snapshot = snapshotRegularFile(receiptPath, RECEIPT_MAX_BYTES, 'manifest transaction receipt');
    if (!snapshot.existed) return undefined;
    parsed = JSON.parse(snapshot.contents!.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Partial<WorkspaceManifestClaimReceipt>;
  const expected = receipt.expected;
  if (receipt.version !== 1 ||
      (receipt.phase !== 'prepared' && receipt.phase !== 'ambiguous') ||
      receipt.target !== target || typeof receipt.claim !== 'string' ||
      typeof receipt.token !== 'string' || fileName !== `${receipt.token}.json` ||
      !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.token) ||
      path.dirname(receipt.claim) !== path.dirname(target) ||
      path.basename(receipt.claim) !== `.${path.basename(target)}.${receipt.token}.claim` ||
      (receipt.desired !== undefined &&
        (!receipt.desired || typeof receipt.desired !== 'object' ||
          !Number.isSafeInteger(receipt.desired.size) || receipt.desired.size < 0 ||
          receipt.desired.size > 256 * 1024 || typeof receipt.desired.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(receipt.desired.sha256))) ||
      (receipt.onboardingPairToken !== undefined &&
        (typeof receipt.onboardingPairToken !== 'string' ||
          !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.onboardingPairToken))) ||
      !expected || typeof expected !== 'object' ||
      !Number.isFinite(expected.mode) || !Number.isFinite(expected.dev) ||
      !Number.isFinite(expected.ino) || !Number.isFinite(expected.size) ||
      !Number.isFinite(expected.mtimeMs) ||
      typeof expected.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    return undefined;
  }
  return receipt as WorkspaceManifestClaimReceipt;
}

function manifestClaimOwnsReplacement(
  workspaceRoot: string,
  receipt: WorkspaceManifestClaimReceipt,
  claimed: RegularFileSnapshot,
  current: RegularFileSnapshot,
): boolean {
  if (!receipt.desired || !current.existed || current.size !== receipt.desired.size ||
      sha256(current.contents!) !== receipt.desired.sha256) {
    return false;
  }
  if (!receipt.onboardingPairToken) return true;
  return workspaceOnboardingPairOwnsManifestReplacement(
    workspaceRoot,
    receipt.onboardingPairToken,
    {
      mode: claimed.mode!,
      dev: claimed.dev!,
      ino: claimed.ino!,
      size: claimed.size!,
      mtimeMs: claimed.mtimeMs!,
      sha256: sha256(claimed.contents!),
    },
    {
      size: current.size!,
      sha256: sha256(current.contents!),
    },
  );
}

function writeReceipt(receiptPath: string, receipt: WorkspaceManifestClaimReceipt): void {
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function snapshotMatchesReceipt(
  snapshot: RegularFileSnapshot,
  receipt: WorkspaceManifestClaimReceipt,
): boolean {
  return snapshot.existed &&
    snapshot.mode === receipt.expected.mode &&
    snapshot.dev === receipt.expected.dev &&
    snapshot.ino === receipt.expected.ino &&
    snapshot.size === receipt.expected.size &&
    snapshot.mtimeMs === receipt.expected.mtimeMs &&
    sha256(snapshot.contents!) === receipt.expected.sha256;
}

function snapshotRegularFile(target: string, maxBytes: number, label: string): RegularFileSnapshot {
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

function snapshotsAreExact(left: RegularFileSnapshot, right: RegularFileSnapshot): boolean {
  return left.existed === right.existed && (!left.existed || (
    left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.contents!.equals(right.contents!)
  ));
}

/** ADR-021 (0.4.17) — hard-link cleanup changes ctime without changing the owned file version. */
function snapshotsAreSameVersion(left: RegularFileSnapshot, right: RegularFileSnapshot): boolean {
  return left.existed === right.existed && (!left.existed || (
    left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.contents!.equals(right.contents!)
  ));
}

function transactionOwnerIsActive(token: string): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return activeClaimTokens.has(token);
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function receiptDirectory(workspaceRoot: string): string {
  const configuredHome = process.env.BRAINROUTER_HOME?.trim();
  const brainrouterHome = configuredHome
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), '.brainrouter');
  const workspaceKey = crypto.createHash('sha256')
    .update(fs.realpathSync(workspaceRoot))
    .digest('hex')
    .slice(0, 32);
  return path.join(brainrouterHome, 'transactions', 'workspace-manifest', workspaceKey);
}

function removeReceiptPath(receiptPath: string): void {
  if (!unlinkIfPresent(receiptPath)) return;
  fsyncDirectory(path.dirname(receiptPath));
}

/** ADR-021 (0.4.17) — concurrent cleanup is idempotent; every other unlink failure stays fatal. */
function unlinkIfPresent(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFilesystemEntry(left, right) &&
    (left.mode & 0o777) === (right.mode & 0o777) &&
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
