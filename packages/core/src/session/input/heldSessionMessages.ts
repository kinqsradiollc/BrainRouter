/**
 * ADR-034 — durable recipient-side approval records for untrusted session messages.
 *
 * Held content expires after 24 hours. Approval is recoverable: a crash after
 * approval but before safe-boundary enqueue leaves an approved, unapplied row
 * that the host can replay and then mark applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assessSessionMessageApproval, type SessionMessageRecipientAuthority } from '../../agent/guards/sessionMessageApproval.js';
import { getStateFile } from '../../storage/store.js';
import {
  writeFileAtomic,
  type AtomicFileWriteOptions,
} from '../../util/fs/atomicFile.js';
import {
  MAX_PENDING_SESSION_INPUTS,
  SessionInputQueueFullError,
  peerSessionSteeringFromMessage,
  type PeerSessionSenderDetails,
  type PeerSessionSteeringInput,
} from './inputDelivery.js';
import {
  LOCAL_SESSION_DEFAULT_MAX_AGE_MS,
  type LocalSessionMessage,
} from '../messaging/contracts.js';

export const HELD_SESSION_MESSAGE_MAX_AGE_MS = LOCAL_SESSION_DEFAULT_MAX_AGE_MS;
export const HELD_SESSION_MESSAGE_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const HELD_SESSION_MESSAGE_MAX_RECORDS = 1_000;
export const HELD_SESSION_MESSAGE_LOCK_TIMEOUT_MS = 3_000;

const HELD_SESSION_MESSAGE_LOCK_RETRY_MS = 10;
const HELD_SESSION_MESSAGE_INCOMPLETE_LOCK_GRACE_MS = 500;
const HELD_SESSION_MESSAGE_MAX_STORE_BYTES = 32 * 1024 * 1024;
const HELD_SESSION_MESSAGE_MAX_REASON_BYTES = 2_000;
const HELD_SESSION_MESSAGE_MAX_DEVICE_BYTES = 160;
const HELD_SESSION_MESSAGE_MAX_DETAIL_BYTES = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

let heldStoreWriteHooksForTests: Pick<AtomicFileWriteOptions, 'beforeCommit' | 'onStaged'> = {};

/** Focused durability seam; never configured by production hosts. */
export function __setHeldSessionMessageWriteHooksForTests(
  hooks: Pick<AtomicFileWriteOptions, 'beforeCommit' | 'onStaged'> | undefined,
): void {
  heldStoreWriteHooksForTests = hooks ?? {};
}

export type HeldSessionMessageStatus = 'held' | 'approved' | 'rejected' | 'expired';
export type HeldSessionMessageTerminalReceiptStatus = 'declined' | 'rejected';

export interface HeldSessionMessageRecord extends LocalSessionMessage {
  status: HeldSessionMessageStatus;
  expiresAt: number;
  holdReason: string;
  decidedAt?: number;
  appliedAt?: number;
  /**
   * Exact sender-facing terminal outcome. The local store keeps the compact
   * `rejected` status for both refusal classes, while replay must distinguish
   * an explicit human decline from a policy/address rejection.
   */
  terminalReceiptStatus?: HeldSessionMessageTerminalReceiptStatus;
  /** Authenticated discovery metadata captured by the recipient host. */
  senderDetails?: PeerSessionSenderDetails;
}

interface HeldSessionMessageStore {
  schemaVersion: 1;
  records: HeldSessionMessageRecord[];
}

export type SessionMessageAdmission =
  | { decision: 'apply'; input: PeerSessionSteeringInput }
  | { decision: 'held'; record: HeldSessionMessageRecord }
  | { decision: 'rejected'; record: HeldSessionMessageRecord }
  | { decision: 'applied'; record: HeldSessionMessageRecord }
  | { decision: 'expired'; record: HeldSessionMessageRecord };

export interface ApprovedHeldSessionMessage {
  record: HeldSessionMessageRecord;
  input?: PeerSessionSteeringInput;
}

function heldFile(workspaceRoot: string): string {
  const file = getStateFile(workspaceRoot, 'heldSessionMessages.json');
  ensurePrivateHeldDirectory(path.dirname(file));
  return file;
}

interface HeldSessionMessageLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

/**
 * Serialize the complete read-modify-rename transaction across CLI/Desktop
 * processes. An atomic lock directory avoids platform-specific flock support;
 * dead owners are reaped by pid and an incomplete mkdir-before-owner crash is
 * recoverable after a short grace period. Live contention fails loudly after
 * a fixed bound instead of freezing the host indefinitely.
 */
function withHeldStoreLock<T>(workspaceRoot: string, operation: () => T): T {
  const file = heldFile(workspaceRoot);
  const lockDir = `${file}.lock`;
  const ownerFile = path.join(lockDir, 'owner.json');
  const owner: HeldSessionMessageLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: Date.now(),
  };
  const deadline = Date.now() + HELD_SESSION_MESSAGE_LOCK_TIMEOUT_MS;

  while (true) {
    let createdLock = false;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      createdLock = true;
      fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        if (createdLock) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* exact lock cleanup only */ }
        }
        throw error;
      }
      reapAbandonedLock(lockDir, ownerFile);
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the held session message store lock.');
      }
      const remaining = Math.max(1, Math.min(HELD_SESSION_MESSAGE_LOCK_RETRY_MS, deadline - Date.now()));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
    }
  }

  try {
    return operation();
  } finally {
    releaseHeldStoreLock(lockDir, ownerFile, owner.token);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function reapAbandonedLock(lockDir: string, ownerFile: string): void {
  let lockStat: fs.Stats;
  try {
    lockStat = fs.lstatSync(lockDir);
  } catch (error) {
    // The current owner can release between our EEXIST from mkdir and this
    // inspection. That is ordinary contention; the acquisition loop retries.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(`Unsafe held session message lock: ${lockDir}`);
  }
  let owner: HeldSessionMessageLockOwner | undefined;
  try {
    const raw = readBoundedRegularFile(ownerFile, 4 * 1024, false);
    const parsed = JSON.parse(raw ?? '') as Partial<HeldSessionMessageLockOwner>;
    if (Number.isInteger(parsed.pid) && typeof parsed.token === 'string' && parsed.token &&
        Number.isFinite(parsed.acquiredAt)) {
      owner = parsed as HeldSessionMessageLockOwner;
    }
  } catch {
    // A process can die between mkdir and owner write. The directory mtime
    // supplies a bounded grace window before another writer reclaims it.
  }
  if (owner && processIsAlive(owner.pid)) return;
  if (!owner) {
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs < HELD_SESSION_MESSAGE_INCOMPLETE_LOCK_GRACE_MS) return;
    } catch {
      return;
    }
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* another contender won the reap */ }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH';
  }
}

function releaseHeldStoreLock(lockDir: string, ownerFile: string, token: string): void {
  try {
    const lockStat = fs.lstatSync(lockDir);
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return;
    const owner = JSON.parse(readBoundedRegularFile(ownerFile, 4 * 1024, false) ?? '') as Partial<HeldSessionMessageLockOwner>;
    if (owner.token !== token) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // A stale-lock reaper can win only after this process is no longer live;
    // cleanup is best effort so an operation result is never masked.
  }
}

function readStore(workspaceRoot: string): HeldSessionMessageStore {
  const file = heldFile(workspaceRoot);
  const raw = readBoundedRegularFile(file, HELD_SESSION_MESSAGE_MAX_STORE_BYTES);
  if (raw === undefined) return { schemaVersion: 1, records: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Held session message store is corrupt: ${file}`);
  }
  const records = validateHeldStore(parsed, file);
  return {
    schemaVersion: 1,
    records,
  };
}

function writeStore(workspaceRoot: string, store: HeldSessionMessageStore): void {
  const file = heldFile(workspaceRoot);
  const records = validateHeldStore(store, file);
  const serialized = `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > HELD_SESSION_MESSAGE_MAX_STORE_BYTES) {
    throw new Error('Held session message store exceeds its bounded byte capacity.');
  }
  writeFileAtomic(file, serialized, {
    mode: 0o600,
    ...heldStoreWriteHooksForTests,
  });
}

function ensurePrivateHeldDirectory(directory: string): void {
  const pathStat = fs.lstatSync(directory);
  const realDirectory = fs.realpathSync(directory);
  const resolvedDirectory = path.resolve(directory);
  const sameResolvedDirectory = process.platform === 'win32'
    ? realDirectory.toLowerCase() === resolvedDirectory.toLowerCase()
    : realDirectory === resolvedDirectory;
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || !sameResolvedDirectory) {
    throw new Error(`Unsafe held session message directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  if (process.platform !== 'win32' && (fs.statSync(directory).mode & 0o777) !== 0o700) {
    throw new Error(`Held session message directory is not private: ${directory}`);
  }
}

function readBoundedRegularFile(
  file: string,
  maxBytes: number,
  enforcePrivateMode = true,
): string | undefined {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size < 1 || pathStat.size > maxBytes) {
    throw new Error(`Unsafe or invalid held session message file: ${file}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileVersion(pathStat, opened)) {
      throw new Error(`Held session message file changed while opening: ${file}`);
    }
    if (enforcePrivateMode && process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
    const expected = fs.fstatSync(descriptor);
    const raw = fs.readFileSync(descriptor, 'utf8');
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(file);
    if (!sameFileVersion(expected, afterRead) || afterPath.isSymbolicLink() ||
        !afterPath.isFile() || !sameFileVersion(expected, afterPath)) {
      throw new Error(`Held session message file changed while reading: ${file}`);
    }
    return raw;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameFileVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function validateHeldStore(value: unknown, file: string): HeldSessionMessageRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Held session message store has an invalid schema: ${file}`);
  }
  const store = value as Partial<HeldSessionMessageStore>;
  if (store.schemaVersion !== 1 || !Array.isArray(store.records)) {
    throw new Error(`Held session message store has an invalid schema: ${file}`);
  }
  if (store.records.length > HELD_SESSION_MESSAGE_MAX_RECORDS) {
    throw new Error('Held session message store exceeds its bounded record capacity.');
  }
  const identities = new Set<string>();
  return store.records.map((candidate, index) => {
    const record = validateHeldRecord(candidate, index);
    const identity = `${record.targetSessionKey}\u0000${record.id}`;
    if (identities.has(identity)) {
      throw new Error(`Held session message store contains duplicate record identity at index ${index}.`);
    }
    identities.add(identity);
    return record;
  });
}

function validateHeldRecord(value: unknown, index: number): HeldSessionMessageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Held session message record ${index} is invalid.`);
  }
  const record = value as Partial<HeldSessionMessageRecord>;
  const id = boundedIdentity(record.id, 160, `record ${index} id`);
  const senderSessionKey = boundedIdentity(record.senderSessionKey, 512, `record ${index} sender key`);
  const senderDeviceId = boundedIdentity(
    record.senderDeviceId,
    HELD_SESSION_MESSAGE_MAX_DEVICE_BYTES,
    `record ${index} device id`,
  );
  const targetSessionKey = boundedIdentity(record.targetSessionKey, 512, `record ${index} target key`);
  const text = boundedText(record.text, 20_000, `record ${index} text`);
  if (record.source !== 'peer-session' || record.trust !== 'untrusted-session') {
    throw new Error(`Held session message record ${index} has invalid trust metadata.`);
  }
  const createdAt = nonNegativeTimestamp(record.createdAt, `record ${index} createdAt`);
  const receivedAt = nonNegativeTimestamp(record.receivedAt, `record ${index} receivedAt`);
  const expiresAt = nonNegativeTimestamp(record.expiresAt, `record ${index} expiresAt`);
  const receiverDeadline = receivedAt + HELD_SESSION_MESSAGE_MAX_AGE_MS;
  const senderDeadline = createdAt + HELD_SESSION_MESSAGE_MAX_AGE_MS;
  if (expiresAt < createdAt ||
      (expiresAt !== receiverDeadline && expiresAt > senderDeadline)) {
    throw new Error(`Held session message record ${index} has an invalid expiry.`);
  }
  if (record.status !== 'held' && record.status !== 'approved' &&
      record.status !== 'rejected' && record.status !== 'expired') {
    throw new Error(`Held session message record ${index} has an invalid status.`);
  }
  const holdReason = boundedText(
    record.holdReason,
    HELD_SESSION_MESSAGE_MAX_REASON_BYTES,
    `record ${index} hold reason`,
  );
  const decidedAt = optionalTimestamp(record.decidedAt, `record ${index} decidedAt`);
  const appliedAt = optionalTimestamp(record.appliedAt, `record ${index} appliedAt`);
  if ((record.status === 'approved' || record.status === 'rejected' || record.status === 'expired') &&
      decidedAt === undefined) {
    throw new Error(`Held session message record ${index} is missing its decision timestamp.`);
  }
  if (record.status !== 'approved' && appliedAt !== undefined) {
    throw new Error(`Held session message record ${index} has an invalid application timestamp.`);
  }
  if (record.terminalReceiptStatus !== undefined &&
      record.terminalReceiptStatus !== 'declined' && record.terminalReceiptStatus !== 'rejected') {
    throw new Error(`Held session message record ${index} has an invalid terminal receipt.`);
  }
  if (record.terminalReceiptStatus !== undefined && record.status !== 'rejected') {
    throw new Error(`Held session message record ${index} has a terminal receipt before rejection.`);
  }
  const senderDetails = validateSenderDetails(record.senderDetails, index);
  return {
    id,
    senderSessionKey,
    senderDeviceId,
    targetSessionKey,
    text,
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt,
    receivedAt,
    status: record.status,
    expiresAt,
    holdReason,
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(record.terminalReceiptStatus ? { terminalReceiptStatus: record.terminalReceiptStatus } : {}),
    ...(senderDetails ? { senderDetails } : {}),
  };
}

function validateSenderDetails(
  value: PeerSessionSenderDetails | undefined,
  index: number,
): PeerSessionSenderDetails | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Held session message record ${index} has invalid sender details.`);
  }
  if (value.clientKind !== undefined && value.clientKind !== 'cli' && value.clientKind !== 'desktop') {
    throw new Error(`Held session message record ${index} has invalid sender client kind.`);
  }
  if (value.transport !== undefined && value.transport !== 'local' && value.transport !== 'remote') {
    throw new Error(`Held session message record ${index} has invalid sender transport.`);
  }
  return {
    ...(value.clientKind ? { clientKind: value.clientKind } : {}),
    ...(value.workspaceRoot !== undefined
      ? { workspaceRoot: boundedDisplay(value.workspaceRoot, HELD_SESSION_MESSAGE_MAX_DETAIL_BYTES, `record ${index} workspace`) }
      : {}),
    ...(value.title !== undefined
      ? { title: boundedDisplay(value.title, HELD_SESSION_MESSAGE_MAX_DETAIL_BYTES, `record ${index} title`) }
      : {}),
    ...(value.transport ? { transport: value.transport } : {}),
  };
}

function boundedIdentity(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      CONTROL_CHARACTER.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Held session message ${label} is invalid.`);
  }
  return value;
}

function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Held session message ${label} is invalid.`);
  }
  return value;
}

function boundedDisplay(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value) ||
      Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`Held session message ${label} is invalid.`);
  }
  return value;
}

function nonNegativeTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Held session message ${label} is invalid.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeTimestamp(value, label);
}

function cloneRecord(record: HeldSessionMessageRecord): HeldSessionMessageRecord {
  return {
    ...record,
    ...(record.senderDetails ? { senderDetails: { ...record.senderDetails } } : {}),
  };
}

function maintainInPlace(store: HeldSessionMessageStore, now: number): { changed: boolean; expiredIds: Set<string> } {
  let expired = 0;
  const expiredIds = new Set<string>();
  for (const record of store.records) {
    const awaitingApplication = record.status === 'held' ||
      (record.status === 'approved' && record.appliedAt === undefined);
    if (!awaitingApplication || record.expiresAt > now) continue;
    record.status = 'expired';
    record.decidedAt = now;
    expiredIds.add(record.id);
    expired += 1;
  }
  const cutoff = now - HELD_SESSION_MESSAGE_TERMINAL_RETENTION_MS;
  const before = store.records.length;
  store.records = store.records.filter((record) => {
    const terminalAt = record.status === 'approved' && record.appliedAt !== undefined
      ? record.appliedAt
      : record.status === 'rejected' || record.status === 'expired'
        ? record.decidedAt
        : undefined;
    return terminalAt === undefined || terminalAt > cutoff;
  });
  return { changed: expired > 0 || store.records.length !== before, expiredIds };
}

function sameMessage(left: HeldSessionMessageRecord, right: LocalSessionMessage): boolean {
  return left.senderSessionKey === right.senderSessionKey &&
    left.senderDeviceId === right.senderDeviceId &&
    left.targetSessionKey === right.targetSessionKey &&
    left.text === right.text &&
    left.createdAt === right.createdAt &&
    left.expiresAt === messageExpiry(right);
}

/** Decide at the recipient and durably hold when its effective authority is unsafe. */
export function admitSessionMessage(
  workspaceRoot: string,
  message: LocalSessionMessage,
  authority: SessionMessageRecipientAuthority,
  now = Date.now(),
  senderDetails: PeerSessionSenderDetails = {},
): SessionMessageAdmission {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    const existing = findExistingRecord(store, message);
    if (existing) {
      assertSameMessage(existing, message);
      const senderChanged = mergeSenderDetails(existing, senderDetails);
      if (maintenance.changed || senderChanged) writeStore(workspaceRoot, store);
      return admissionForExisting(existing);
    }
    if (messageExpiry(message) <= now) {
      const record = holdSessionMessageInStore(
        store,
        message,
        'No durable application acknowledgement was recorded before expiry.',
        now,
        senderDetails,
      );
      writeStore(workspaceRoot, store);
      return { decision: 'expired', record };
    }
    const assessment = assessSessionMessageApproval(authority);
    if (!assessment.hold) {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      return { decision: 'apply', input: peerSessionSteeringFromMessage(message, senderDetails) };
    }
    const record = holdSessionMessageInStore(store, message, assessment.reason, now, senderDetails);
    writeStore(workspaceRoot, store);
    return record.status === 'expired'
      ? { decision: 'expired', record }
      : { decision: 'held', record };
  });
}

export function holdSessionMessage(
  workspaceRoot: string,
  message: LocalSessionMessage,
  holdReason: string,
  now = Date.now(),
  senderDetails: PeerSessionSenderDetails = {},
): HeldSessionMessageRecord {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    const existing = findExistingRecord(store, message);
    if (existing) {
      assertSameMessage(existing, message);
      const senderChanged = mergeSenderDetails(existing, senderDetails);
      if (maintenance.changed || senderChanged) writeStore(workspaceRoot, store);
      return cloneRecord(existing);
    }
    const record = holdSessionMessageInStore(store, message, holdReason, now, senderDetails);
    writeStore(workspaceRoot, store);
    return record;
  });
}

function holdSessionMessageInStore(
  store: HeldSessionMessageStore,
  message: LocalSessionMessage,
  holdReason: string,
  now: number,
  senderDetails: PeerSessionSenderDetails,
): HeldSessionMessageRecord {
  const active = store.records.filter((record) =>
    record.targetSessionKey === message.targetSessionKey &&
    (record.status === 'held' || record.status === 'approved' && record.appliedAt === undefined)).length;
  if (active >= MAX_PENDING_SESSION_INPUTS) {
    throw new SessionInputQueueFullError('steering', MAX_PENDING_SESSION_INPUTS);
  }
  if (store.records.length >= HELD_SESSION_MESSAGE_MAX_RECORDS) {
    throw new SessionInputQueueFullError('steering', HELD_SESSION_MESSAGE_MAX_RECORDS);
  }
  const expiresAt = messageExpiry(message);
  const record: HeldSessionMessageRecord = {
    ...message,
    status: expiresAt <= now ? 'expired' : 'held',
    expiresAt,
    holdReason,
    ...(Object.keys(senderDetails).length > 0 ? { senderDetails: { ...senderDetails } } : {}),
    ...(expiresAt <= now ? { decidedAt: now } : {}),
  };
  store.records.push(record);
  return cloneRecord(record);
}

function messageExpiry(message: LocalSessionMessage): number {
  return message.expiresAt ?? message.receivedAt + HELD_SESSION_MESSAGE_MAX_AGE_MS;
}

function findExistingRecord(
  store: HeldSessionMessageStore,
  message: Pick<LocalSessionMessage, 'id' | 'targetSessionKey'>,
): HeldSessionMessageRecord | undefined {
  return store.records.find((record) =>
    record.id === message.id && record.targetSessionKey === message.targetSessionKey);
}

function assertSameMessage(existing: HeldSessionMessageRecord, message: LocalSessionMessage): void {
  if (!sameMessage(existing, message)) {
    throw new Error(`Held session message id "${message.id}" was reused with different content.`);
  }
}

function mergeSenderDetails(
  record: HeldSessionMessageRecord,
  senderDetails: PeerSessionSenderDetails,
): boolean {
  if (Object.keys(senderDetails).length === 0) return false;
  const merged = { ...record.senderDetails, ...senderDetails };
  if (JSON.stringify(merged) === JSON.stringify(record.senderDetails)) return false;
  record.senderDetails = merged;
  return true;
}

function admissionForExisting(record: HeldSessionMessageRecord): SessionMessageAdmission {
  if (record.status === 'expired') return { decision: 'expired', record: cloneRecord(record) };
  if (record.status === 'rejected') return { decision: 'rejected', record: cloneRecord(record) };
  if (record.status === 'held') return { decision: 'held', record: cloneRecord(record) };
  if (record.appliedAt !== undefined) return { decision: 'applied', record: cloneRecord(record) };
  return { decision: 'apply', input: peerSessionSteeringFromMessage(record, record.senderDetails) };
}

export function listHeldSessionMessages(
  workspaceRoot: string,
  sessionKey: string,
  options: { status?: HeldSessionMessageStatus; now?: number } = {},
): HeldSessionMessageRecord[] {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    if (maintainInPlace(store, options.now ?? Date.now()).changed) writeStore(workspaceRoot, store);
    return store.records
      .filter((record) => record.targetSessionKey === sessionKey)
      .filter((record) => !options.status || record.status === options.status)
      .map(cloneRecord);
  });
}

export function expireHeldSessionMessages(
  workspaceRoot: string,
  now = Date.now(),
): HeldSessionMessageRecord[] {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    if (!maintenance.changed) return [];
    writeStore(workspaceRoot, store);
    return store.records
      .filter((record) => maintenance.expiredIds.has(record.id) && record.status === 'expired')
      .map(cloneRecord);
  });
}

/** Approve once; an unapplied approval can be replayed after a crash. */
export function approveHeldSessionMessage(
  workspaceRoot: string,
  sessionKey: string,
  messageId: string,
  now = Date.now(),
): ApprovedHeldSessionMessage {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    const record = store.records.find((candidate) =>
      candidate.targetSessionKey === sessionKey && candidate.id === messageId);
    if (!record) {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Unknown held session message "${messageId}".`);
    }
    if (record.status === 'expired') {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      return { record: cloneRecord(record) };
    }
    if (record.status === 'rejected') {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      return { record: cloneRecord(record) };
    }
    if (record.status === 'held') {
      record.status = 'approved';
      record.decidedAt = now;
      writeStore(workspaceRoot, store);
    } else if (maintenance.changed) {
      writeStore(workspaceRoot, store);
    }
    return {
      record: cloneRecord(record),
      ...(!record.appliedAt ? { input: peerSessionSteeringFromMessage(record, record.senderDetails) } : {}),
    };
  });
}

export function rejectHeldSessionMessage(
  workspaceRoot: string,
  sessionKey: string,
  messageId: string,
  now = Date.now(),
): HeldSessionMessageRecord {
  // The returned record is the authoritative compare-and-set result. Expiry
  // can win while a prompt is open, in which case callers must report expired
  // rather than the requested rejection.
  return terminalizeHeldSessionMessage(workspaceRoot, sessionKey, messageId, 'rejected', now);
}

/** Record an explicit human refusal while preserving the compact local status. */
export function declineHeldSessionMessage(
  workspaceRoot: string,
  sessionKey: string,
  messageId: string,
  now = Date.now(),
): HeldSessionMessageRecord {
  // Delayed human intent likewise cannot overwrite a terminal expiry.
  return terminalizeHeldSessionMessage(workspaceRoot, sessionKey, messageId, 'declined', now);
}

function terminalizeHeldSessionMessage(
  workspaceRoot: string,
  sessionKey: string,
  messageId: string,
  terminalReceiptStatus: HeldSessionMessageTerminalReceiptStatus,
  now: number,
): HeldSessionMessageRecord {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    const record = store.records.find((candidate) =>
      candidate.targetSessionKey === sessionKey && candidate.id === messageId);
    if (!record) {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Unknown held session message "${messageId}".`);
    }
    if (record.status === 'approved') {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Held session message "${messageId}" was already approved.`);
    }
    if (record.status === 'held') {
      record.status = 'rejected';
      record.decidedAt = now;
      record.terminalReceiptStatus = terminalReceiptStatus;
      writeStore(workspaceRoot, store);
    } else if (maintenance.changed) {
      writeStore(workspaceRoot, store);
    }
    return cloneRecord(record);
  });
}

export function markHeldSessionMessageApplied(
  workspaceRoot: string,
  sessionKey: string,
  messageId: string,
  now = Date.now(),
): HeldSessionMessageRecord {
  return withHeldStoreLock(workspaceRoot, () => {
    const store = readStore(workspaceRoot);
    const maintenance = maintainInPlace(store, now);
    const record = store.records.find((candidate) =>
      candidate.targetSessionKey === sessionKey && candidate.id === messageId);
    if (!record) {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Unknown held session message "${messageId}".`);
    }
    if (record.status === 'expired') {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Held session message "${messageId}" expired before a durable application acknowledgement.`);
    }
    if (record.status !== 'approved') {
      if (maintenance.changed) writeStore(workspaceRoot, store);
      throw new Error(`Held session message "${messageId}" is not approved.`);
    }
    if (!record.appliedAt) {
      record.appliedAt = now;
      writeStore(workspaceRoot, store);
    } else if (maintenance.changed) {
      writeStore(workspaceRoot, store);
    }
    return cloneRecord(record);
  });
}
