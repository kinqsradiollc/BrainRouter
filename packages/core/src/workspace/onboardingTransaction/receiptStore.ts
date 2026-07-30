/**
 * Durable workspace-onboarding receipt store.
 *
 * A25-5c: owns bounded persistence, receipt validation, safe-directory
 * enforcement, cleanup, and owner liveness independently of transaction
 * orchestration. Callers retain phase policy and in-process ownership state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';
import {
  INSTRUCTION_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  RECEIPT_LIMIT,
  RECEIPT_MAX_BYTES,
  type PairPhase,
  type WorkspaceOnboardingPairReceipt,
} from './contracts.js';
import {
  snapshotRegularFile,
  validDesiredVersion,
  validEncodedSnapshot,
  validEncodedVersion,
} from './fileSnapshots.js';

export interface StoredWorkspaceOnboardingReceipt {
  fileName: string;
  receiptPath: string;
  receipt: WorkspaceOnboardingPairReceipt;
}

export function prepareWorkspaceOnboardingReceiptPath(
  workspaceRoot: string,
  token: string,
): string {
  const directory = workspaceOnboardingReceiptDirectory(workspaceRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeWorkspaceOnboardingReceiptDirectory(directory);
  const existing = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+\.[0-9a-f]{24}\.json$/.test(name));
  if (existing.length >= RECEIPT_LIMIT) {
    throw new Error(
      'Too many pending workspace onboarding transactions; manual recovery is required.',
    );
  }
  return path.join(directory, `${token}.json`);
}

export function listWorkspaceOnboardingReceipts(
  workspaceRoot: string,
): StoredWorkspaceOnboardingReceipt[] {
  const directory = workspaceOnboardingReceiptDirectory(workspaceRoot);
  try {
    assertSafeWorkspaceOnboardingReceiptDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+\.[0-9a-f]{24}\.json$/.test(name))
    .sort();
  if (entries.length > RECEIPT_LIMIT) {
    throw new Error(
      'Too many pending workspace onboarding transactions; manual recovery is required.',
    );
  }
  return entries.map((fileName) => {
    const receiptPath = path.join(directory, fileName);
    const receipt = readWorkspaceOnboardingReceipt(
      receiptPath,
      workspaceRoot,
      fileName,
    );
    if (!receipt) {
      throw new Error(
        `Invalid workspace onboarding transaction receipt: ${receiptPath}`,
      );
    }
    return { fileName, receiptPath, receipt };
  });
}

export function readWorkspaceOnboardingReceiptForToken(
  workspaceRoot: string,
  token: string,
): WorkspaceOnboardingPairReceipt | undefined {
  const directory = workspaceOnboardingReceiptDirectory(workspaceRoot);
  try {
    assertSafeWorkspaceOnboardingReceiptDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const fileName = `${token}.json`;
  return readWorkspaceOnboardingReceipt(
    path.join(directory, fileName),
    workspaceRoot,
    fileName,
  );
}

export function writeWorkspaceOnboardingReceipt(
  receiptPath: string,
  receipt: WorkspaceOnboardingPairReceipt,
  exclusive = false,
): void {
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(serialized) > RECEIPT_MAX_BYTES) {
    throw new Error(
      `Workspace onboarding transaction receipt exceeds ${RECEIPT_MAX_BYTES} bytes.`,
    );
  }
  writeFileAtomic(receiptPath, serialized, { mode: 0o600, exclusive });
}

export function readWorkspaceOnboardingReceipt(
  receiptPath: string,
  workspaceRoot: string,
  fileName: string,
): WorkspaceOnboardingPairReceipt | undefined {
  let parsed: unknown;
  try {
    const snapshot = snapshotRegularFile(
      receiptPath,
      RECEIPT_MAX_BYTES,
      'workspace onboarding receipt',
    );
    if (!snapshot.existed) return undefined;
    parsed = JSON.parse(snapshot.contents!.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const receipt = parsed as Partial<WorkspaceOnboardingPairReceipt>;
  if (receipt.version !== 1 || !isPairPhase(receipt.phase) ||
      receipt.workspaceRoot !== workspaceRoot || typeof receipt.token !== 'string' ||
      fileName !== `${receipt.token}.json` ||
      !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.token) ||
      !validReceiptInstruction(receipt.instruction, workspaceRoot) ||
      !validReceiptManifest(receipt.manifest) ||
      !validReceiptPhaseState(receipt as WorkspaceOnboardingPairReceipt)) {
    return undefined;
  }
  return receipt as WorkspaceOnboardingPairReceipt;
}

export function markWorkspaceOnboardingReceiptAmbiguous(
  receiptPath: string,
  receipt: WorkspaceOnboardingPairReceipt,
): void {
  if (receipt.phase !== 'ambiguous') {
    writeWorkspaceOnboardingReceipt(
      receiptPath,
      { ...receipt, phase: 'ambiguous' },
    );
  }
}

export function workspaceOnboardingTransactionOwnerIsActive(
  token: string,
  localTokenIsActive: (token: string) => boolean,
  processIsActive: (pid: number) => boolean = defaultProcessIsActive,
): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return localTokenIsActive(token);
  return processIsActive(ownerPid);
}

export function removeWorkspaceOnboardingReceipt(receiptPath: string): void {
  try {
    fs.unlinkSync(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fsyncDirectory(path.dirname(receiptPath));
}

export function workspaceOnboardingReceiptDirectory(
  workspaceRoot: string,
): string {
  const configuredHome = process.env.BRAINROUTER_HOME?.trim();
  const brainrouterHome = configuredHome
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), '.brainrouter');
  const workspaceKey = crypto.createHash('sha256')
    .update(fs.realpathSync(workspaceRoot))
    .digest('hex')
    .slice(0, 32);
  return path.join(
    brainrouterHome,
    'transactions',
    'workspace-onboarding',
    workspaceKey,
  );
}

function validReceiptInstruction(
  value: WorkspaceOnboardingPairReceipt['instruction'] | undefined,
  workspaceRoot: string,
): boolean {
  if (!value || !validEncodedSnapshot(value.before, INSTRUCTION_MAX_BYTES) ||
      !validDesiredVersion(value.desired, INSTRUCTION_MAX_BYTES)) {
    return false;
  }
  if (value.outcome !== undefined && value.outcome !== 'created' &&
      value.outcome !== 'unchanged') {
    return false;
  }
  if (value.after !== undefined &&
      !validEncodedVersion(value.after, INSTRUCTION_MAX_BYTES)) {
    return false;
  }
  if (value.staged !== undefined) {
    const expectedDirectory = path.join(workspaceRoot);
    if (!validEncodedVersion(value.staged, INSTRUCTION_MAX_BYTES) ||
        path.dirname(value.staged.temporaryPath) !== expectedDirectory ||
        !/^\.AGENT\.md\.[0-9]+\.[0-9a-f]{24}\.tmp$/.test(
          path.basename(value.staged.temporaryPath),
        )) {
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
    (value.after === undefined ||
      validEncodedVersion(value.after, MANIFEST_MAX_BYTES));
}

function validReceiptPhaseState(
  receipt: WorkspaceOnboardingPairReceipt,
): boolean {
  const instructionEmpty = receipt.instruction.outcome === undefined &&
    receipt.instruction.after === undefined;
  const instructionRecorded = receipt.instruction.outcome !== undefined &&
    receipt.instruction.after !== undefined;
  if (!instructionEmpty && !instructionRecorded) return false;
  if (receipt.phase === 'ambiguous') return true;
  if (receipt.phase === 'prepared') {
    return receipt.instruction.staged === undefined && instructionEmpty &&
      receipt.manifest.after === undefined;
  }
  if (receipt.phase === 'instruction-committing') {
    return instructionEmpty && receipt.manifest.after === undefined;
  }
  if (receipt.phase === 'instruction-written' ||
      receipt.phase === 'manifest-committing') {
    return instructionRecorded && receipt.manifest.after === undefined;
  }
  return instructionRecorded && receipt.manifest.after !== undefined;
}

function isPairPhase(value: unknown): value is PairPhase {
  return value === 'prepared' || value === 'instruction-committing' ||
    value === 'instruction-written' || value === 'manifest-committing' ||
    value === 'manifest-written' || value === 'ambiguous';
}

function assertSafeWorkspaceOnboardingReceiptDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Unsafe workspace onboarding transaction directory: ${directory}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Unsafe workspace onboarding transaction directory permissions: ${directory}`,
    );
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && stat.uid !== currentUser) {
    throw new Error(
      `Unsafe workspace onboarding transaction directory owner: ${directory}`,
    );
  }
}

function defaultProcessIsActive(ownerPid: number): boolean {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' &&
        code !== 'EISDIR') {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort descriptor cleanup.
      }
    }
  }
}
