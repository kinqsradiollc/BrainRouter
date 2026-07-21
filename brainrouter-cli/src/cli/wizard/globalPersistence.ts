/**
 * Recoverable global setup persistence for BrainRouter CLI (0.4.17).
 *
 * Commits the user config and onboarding marker as one logical state transition
 * even though the filesystem cannot replace both atomically. Private, bounded
 * receipts and exact-version claims support crash recovery and compare-and-swap;
 * concurrent ownership is never overwritten, and ambiguous files are preserved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getConfigPath,
  loadOrInitConfig,
  saveConfigOrThrow,
  type Config,
} from '@kinqs/brainrouter-core/config';
import { writeFileAtomic } from '@kinqs/brainrouter-core/util';

export const ONBOARDED_MARKER = path.join(
  os.homedir(),
  '.config',
  'brainrouter',
  '.onboarded',
);

export function isOnboarded(markerPath = ONBOARDED_MARKER): boolean {
  if (markerPath === ONBOARDED_MARKER) {
    recoverGlobalSetupState();
  } else {
    recoverInterruptedGlobalClaims(markerPath, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES);
  }
  return isRegularFileNoFollow(markerPath);
}

/** Recover config and marker claims before readiness checks or config loads. */
export function recoverGlobalSetupState(
  configPath = getConfigPath(),
  markerPath = ONBOARDED_MARKER,
): void {
  const coordinator = { configPath, markerPath };
  recoverInterruptedGlobalClaims(configPath, GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES, coordinator);
  recoverInterruptedGlobalClaims(markerPath, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES, coordinator);
  recoverInterruptedGlobalSetupTransactions(configPath, markerPath);
}

/** Readiness checks accept only a real regular file, never a directory or symlink. */
export function isRegularFileNoFollow(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

export function markOnboarded(): boolean {
  try {
    recoverInterruptedGlobalClaims(ONBOARDED_MARKER, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES);
    writeOnboardedMarkerOrThrow();
    return true;
  } catch {
    return false;
  }
}

export interface GlobalSetupPersistence {
  configPath: string;
  markerPath: string;
  saveConfig(config: Config, options?: { exclusive?: boolean }): void;
  writeMarker(options?: { exclusive?: boolean }): void;
}

const DEFAULT_PERSISTENCE: GlobalSetupPersistence = {
  configPath: getConfigPath(),
  markerPath: ONBOARDED_MARKER,
  saveConfig: saveConfigOrThrow,
  writeMarker: writeOnboardedMarkerOrThrow,
};

const GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const GLOBAL_MARKER_SNAPSHOT_MAX_BYTES = 64 * 1024;

export interface GlobalSetupRollbackTestEvent {
  stage: 'before-remove-quarantine';
  target: string;
  quarantine: string;
}

export interface GlobalSetupCommitTestEvent {
  stage: 'before-write-claim' | 'after-write-claim' | 'after-write-replacement';
  target: string;
  quarantine: string;
}

export interface GlobalSetupTransactionTestEvent {
  stage: 'after-config-commit' | 'after-marker-commit';
  configPath: string;
  markerPath: string;
}

let globalSetupRollbackHookForTests:
  ((event: GlobalSetupRollbackTestEvent) => void) | undefined;
let globalSetupCommitHookForTests:
  ((event: GlobalSetupCommitTestEvent) => void) | undefined;
let globalSetupTransactionHookForTests:
  ((event: GlobalSetupTransactionTestEvent) => void) | undefined;

/** Test seam for deterministic replacement at the destructive rollback boundary. */
export function _setGlobalSetupRollbackHookForTests(
  hook?: (event: GlobalSetupRollbackTestEvent) => void,
): void {
  globalSetupRollbackHookForTests = hook;
}

/** Test seam for deterministic writes immediately after the initial snapshot. */
export function _setGlobalSetupCommitHookForTests(
  hook?: (event: GlobalSetupCommitTestEvent) => void,
): void {
  globalSetupCommitHookForTests = hook;
}

/** Test seam that emulates process death after a durable coordinator phase. */
export function _setGlobalSetupTransactionHookForTests(
  hook?: (event: GlobalSetupTransactionTestEvent) => void,
): void {
  globalSetupTransactionHookForTests = hook;
}

/**
 * Commit config plus its readiness marker as one recoverable operation. The
 * files cannot be renamed atomically together, so exact byte snapshots are
 * restored if either write fails. Callers persist non-essential preferences
 * only after this returns.
 */
export function persistGlobalSetupOrThrow(
  config: Config,
  persistence: GlobalSetupPersistence = DEFAULT_PERSISTENCE,
): void {
  persistGlobalSetupWithExpectedVersion(config, persistence);
}

export interface GlobalSetupUpdateDependencies {
  persistence?: GlobalSetupPersistence;
  loadConfig?: () => Config;
}

/**
 * Load, transform, and commit setup config against the exact file version that
 * existed before the load. This closes the caller-side gap where another
 * process could replace config after a wizard loaded it but before the
 * persistence transaction captured its compare-and-swap baseline.
 */
export function updateGlobalSetupConfigOrThrow(
  update: (current: Config) => Config,
  dependencies: GlobalSetupUpdateDependencies = {},
): Config {
  const persistence = dependencies.persistence ?? DEFAULT_PERSISTENCE;
  recoverGlobalSetupState(persistence.configPath, persistence.markerPath);
  const expectedConfig = snapshotFile(
    persistence.configPath,
    GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES,
  );
  const next = update((dependencies.loadConfig ?? loadOrInitConfig)());
  persistGlobalSetupWithExpectedVersion(next, persistence, expectedConfig);
  return next;
}

function persistGlobalSetupWithExpectedVersion(
  config: Config,
  persistence: GlobalSetupPersistence,
  expectedConfig?: FileSnapshot,
): void {
  recoverGlobalSetupState(persistence.configPath, persistence.markerPath);
  const configSnapshot = snapshotFile(persistence.configPath, GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES);
  if (expectedConfig && !snapshotsAreExact(expectedConfig, configSnapshot)) {
    throw new Error('Global config changed while setup was being reviewed; reload setup before saving.');
  }
  const markerSnapshot = snapshotFile(persistence.markerPath, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES);
  const parentDirectories = [...new Set([
    path.dirname(persistence.configPath),
    path.dirname(persistence.markerPath),
  ])].map((directory) => ({ directory, existed: fs.existsSync(directory) }));

  const configStage: FileWriteStage = { attempted: false, completed: false };
  const markerStage: FileWriteStage = { attempted: false, completed: false };
  const coordinator = beginGlobalSetupTransaction(
    persistence.configPath,
    persistence.markerPath,
    configSnapshot,
    markerSnapshot,
    config,
  );
  let simulatedCrash = false;

  try {
    updateGlobalSetupTransaction(coordinator, { phase: 'config-committing' });
    configStage.attempted = true;
    writeFileWithExpectedVersion(
      persistence.configPath,
      configSnapshot,
      GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES,
      () => persistence.saveConfig(config, { exclusive: true }),
      coordinator,
    );
    configStage.completed = true;
    configStage.after = snapshotFile(persistence.configPath, GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES);
    updateGlobalSetupTransaction(coordinator, {
      phase: 'config-written',
      configAfter: serializeSnapshot(configStage.after),
    });
    try {
      globalSetupTransactionHookForTests?.({
        stage: 'after-config-commit',
        configPath: persistence.configPath,
        markerPath: persistence.markerPath,
      });
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }

    updateGlobalSetupTransaction(coordinator, { phase: 'marker-committing' });
    markerStage.attempted = true;
    writeFileWithExpectedVersion(
      persistence.markerPath,
      markerSnapshot,
      GLOBAL_MARKER_SNAPSHOT_MAX_BYTES,
      () => persistence.writeMarker({ exclusive: true }),
      coordinator,
    );
    markerStage.completed = true;
    markerStage.after = snapshotFile(persistence.markerPath, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES);
    updateGlobalSetupTransaction(coordinator, {
      phase: 'marker-written',
      configAfter: serializeSnapshot(configStage.after),
      markerAfter: serializeSnapshot(markerStage.after),
    });
    try {
      globalSetupTransactionHookForTests?.({
        stage: 'after-marker-commit',
        configPath: persistence.configPath,
        markerPath: persistence.markerPath,
      });
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    removeGlobalSetupTransaction(coordinator);
  } catch (error) {
    if (simulatedCrash) throw error;
    const rollbackErrors = [
      rollbackFile(
        persistence.markerPath,
        markerSnapshot,
        markerStage,
        GLOBAL_MARKER_SNAPSHOT_MAX_BYTES,
      ),
      rollbackFile(
        persistence.configPath,
        configSnapshot,
        configStage,
        GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES,
      ),
    ].filter((candidate): candidate is Error => candidate instanceof Error);

    if (rollbackErrors.length > 0) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [original, ...rollbackErrors],
        `Global setup failed and rollback was incomplete: ${original.message}`,
      );
    }
    removeGlobalSetupTransaction(coordinator);
    const directoryErrors = parentDirectories
      .filter(({ existed }) => !existed)
      .sort((a, b) => b.directory.length - a.directory.length)
      .map(({ directory }) => removeEmptyDirectory(directory))
      .filter((candidate): candidate is Error => candidate instanceof Error);
    if (directoryErrors.length > 0) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [original, ...directoryErrors],
        `Global setup failed and rollback was incomplete: ${original.message}`,
      );
    }
    throw error;
  } finally {
    activeGlobalSetupTransactions.delete(coordinator.value.token);
  }
}

function writeOnboardedMarkerOrThrow(options: { exclusive?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(ONBOARDED_MARKER), { recursive: true, mode: 0o700 });
  writeFileAtomic(ONBOARDED_MARKER, '', { mode: 0o600, exclusive: options.exclusive });
}

interface FileSnapshot {
  existed: boolean;
  contents?: Buffer;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

interface FileWriteStage {
  attempted: boolean;
  completed: boolean;
  after?: FileSnapshot;
}

type GlobalSetupTransactionPhase =
  | 'prepared'
  | 'config-committing'
  | 'config-written'
  | 'marker-committing'
  | 'marker-written'
  | 'ambiguous';

interface DurableFileSnapshot {
  existed: boolean;
  contents?: string;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

interface DesiredFileVersion {
  mode: number;
  size: number;
  sha256: string;
}

interface GlobalSetupTransactionReceipt {
  version: 1;
  phase: GlobalSetupTransactionPhase;
  token: string;
  configPath: string;
  markerPath: string;
  configBefore: DurableFileSnapshot;
  markerBefore: DurableFileSnapshot;
  desiredConfig: DesiredFileVersion;
  desiredMarker: DesiredFileVersion;
  configAfter?: DurableFileSnapshot;
  markerAfter?: DurableFileSnapshot;
}

interface ActiveGlobalSetupTransaction {
  path: string;
  value: GlobalSetupTransactionReceipt;
}

const GLOBAL_SETUP_TRANSACTION_MAX_BYTES = (GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES * 2) +
  (GLOBAL_MARKER_SNAPSHOT_MAX_BYTES * 2) + (1024 * 1024);
const GLOBAL_SETUP_TRANSACTION_LIMIT = 16;
const activeGlobalSetupTransactions = new Set<string>();

function beginGlobalSetupTransaction(
  configPath: string,
  markerPath: string,
  configBefore: FileSnapshot,
  markerBefore: FileSnapshot,
  config: Config,
): ActiveGlobalSetupTransaction {
  const token = `${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(directory, `.global-setup.${token}.txn.json`);
  const desiredConfigBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  const desiredMarkerBytes = Buffer.alloc(0);
  const value: GlobalSetupTransactionReceipt = {
    version: 1,
    phase: 'prepared',
    token,
    configPath,
    markerPath,
    configBefore: serializeSnapshot(configBefore),
    markerBefore: serializeSnapshot(markerBefore),
    desiredConfig: desiredVersion(desiredConfigBytes, 0o600),
    desiredMarker: desiredVersion(desiredMarkerBytes, 0o600),
  };
  activeGlobalSetupTransactions.add(token);
  try {
    writeGlobalSetupTransaction(receiptPath, value, true);
  } catch (error) {
    activeGlobalSetupTransactions.delete(token);
    throw error;
  }
  return { path: receiptPath, value };
}

function updateGlobalSetupTransaction(
  active: ActiveGlobalSetupTransaction,
  update: Partial<Pick<GlobalSetupTransactionReceipt, 'phase' | 'configAfter' | 'markerAfter'>>,
): void {
  Object.assign(active.value, update);
  writeGlobalSetupTransaction(active.path, active.value, false);
}

function writeGlobalSetupTransaction(
  receiptPath: string,
  receipt: GlobalSetupTransactionReceipt,
  exclusive: boolean,
): void {
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
    exclusive,
  });
}

function removeGlobalSetupTransaction(active: ActiveGlobalSetupTransaction): void {
  const current = readGlobalSetupTransaction(
    active.path,
    active.value.configPath,
    active.value.markerPath,
    path.basename(active.path),
  );
  if (!current || current.token !== active.value.token || current.phase !== active.value.phase) {
    throw new Error('Global setup coordinator receipt changed before cleanup.');
  }
  fs.unlinkSync(active.path);
  fsyncDirectory(path.dirname(active.path));
}

function recoverInterruptedGlobalSetupTransactions(configPath: string, markerPath: string): void {
  const directory = path.dirname(configPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe global setup coordinator directory: ${directory}`);
  }
  const entries = fs.readdirSync(directory)
    .filter((name) => /^\.global-setup\.[0-9]+\.[0-9a-f]{24}\.txn\.json$/.test(name))
    .sort();
  if (entries.length > GLOBAL_SETUP_TRANSACTION_LIMIT) {
    throw new Error('Too many pending global setup transactions; manual recovery is required.');
  }

  for (const name of entries) {
    const receiptPath = path.join(directory, name);
    const receipt = readGlobalSetupTransaction(receiptPath, configPath, markerPath, name);
    if (!receipt || globalSetupTransactionOwnerIsActive(receipt.token) || receipt.phase === 'ambiguous') {
      continue;
    }
    const configCurrent = snapshotFile(configPath, GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES);
    const markerCurrent = snapshotFile(markerPath, GLOBAL_MARKER_SNAPSHOT_MAX_BYTES);
    const configBefore = deserializeSnapshot(receipt.configBefore);
    const markerBefore = deserializeSnapshot(receipt.markerBefore);
    const configIsBefore = snapshotMatchesDurable(configCurrent, receipt.configBefore);
    const markerIsBefore = snapshotMatchesDurable(markerCurrent, receipt.markerBefore);
    const configIsDesired = snapshotMatchesDesired(configCurrent, receipt.desiredConfig);
    const markerIsDesired = snapshotMatchesDesired(markerCurrent, receipt.desiredMarker);
    const configIsAfter = receipt.configAfter
      ? snapshotMatchesDurable(configCurrent, receipt.configAfter)
      : false;
    const markerIsAfter = receipt.markerAfter
      ? snapshotMatchesDurable(markerCurrent, receipt.markerAfter)
      : false;

    if (receipt.phase === 'marker-written' && configIsAfter && markerIsAfter) {
      removeCoordinatorPath(receiptPath);
      continue;
    }
    if ((receipt.phase === 'config-written' || receipt.phase === 'marker-committing') &&
        configIsAfter && markerIsDesired) {
      // The marker syscall committed and the process died before advancing the
      // WAL. Both desired files are durable, so complete the transaction.
      removeCoordinatorPath(receiptPath);
      continue;
    }
    if ((receipt.phase === 'prepared' || receipt.phase === 'config-committing') &&
        configIsDesired && markerIsDesired) {
      removeCoordinatorPath(receiptPath);
      continue;
    }

    const shouldRollbackConfig = markerIsBefore && (
      ((receipt.phase === 'config-written' || receipt.phase === 'marker-committing') && configIsAfter) ||
      ((receipt.phase === 'prepared' || receipt.phase === 'config-committing') && configIsDesired)
    );
    if (shouldRollbackConfig) {
      const rollbackError = restoreCrashSnapshot(
        configPath,
        configBefore,
        configCurrent,
        GLOBAL_CONFIG_SNAPSHOT_MAX_BYTES,
      );
      if (!rollbackError) {
        removeCoordinatorPath(receiptPath);
        continue;
      }
    } else if (configIsBefore && markerIsBefore) {
      removeCoordinatorPath(receiptPath);
      continue;
    }

    writeGlobalSetupTransaction(receiptPath, { ...receipt, phase: 'ambiguous' }, false);
  }
}

function restoreCrashSnapshot(
  target: string,
  before: FileSnapshot,
  current: FileSnapshot,
  maxBytes: number,
): Error | undefined {
  try {
    if (!before.existed) return removeOwnedFileVersion(target, current, maxBytes);
    writeFileAtomic(target, before.contents!, {
      mode: before.mode,
      beforeCommit: () => {
        const latest = snapshotFile(target, maxBytes);
        if (!snapshotsAreExact(current, latest)) {
          throw new Error(`Concurrent write detected while recovering ${target}.`);
        }
      },
    });
    const restored = snapshotFile(target, maxBytes);
    if (!restored.existed || restored.mode !== before.mode ||
        !restored.contents!.equals(before.contents!)) {
      throw new Error(`Could not restore the pre-setup contents of ${target}.`);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function readGlobalSetupTransaction(
  receiptPath: string,
  configPath: string,
  markerPath: string,
  fileName: string,
): GlobalSetupTransactionReceipt | undefined {
  let parsed: unknown;
  try {
    const snapshot = snapshotFile(receiptPath, GLOBAL_SETUP_TRANSACTION_MAX_BYTES);
    if (!snapshot.existed) return undefined;
    parsed = JSON.parse(snapshot.contents!.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Partial<GlobalSetupTransactionReceipt>;
  if (receipt.version !== 1 || typeof receipt.token !== 'string' ||
      !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.token) ||
      fileName !== `.global-setup.${receipt.token}.txn.json` ||
      receipt.configPath !== configPath || receipt.markerPath !== markerPath ||
      !isGlobalSetupTransactionPhase(receipt.phase) ||
      !validDurableSnapshot(receipt.configBefore) || !validDurableSnapshot(receipt.markerBefore) ||
      !validDesiredVersion(receipt.desiredConfig) || !validDesiredVersion(receipt.desiredMarker) ||
      (receipt.configAfter !== undefined && !validDurableSnapshot(receipt.configAfter)) ||
      (receipt.markerAfter !== undefined && !validDurableSnapshot(receipt.markerAfter))) {
    return undefined;
  }
  return receipt as GlobalSetupTransactionReceipt;
}

function serializeSnapshot(snapshot: FileSnapshot | undefined): DurableFileSnapshot {
  if (!snapshot) throw new Error('Missing global setup transaction snapshot.');
  if (!snapshot.existed) return { existed: false };
  return {
    existed: true,
    contents: snapshot.contents!.toString('base64'),
    mode: snapshot.mode,
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
    sha256: hashBytes(snapshot.contents!),
  };
}

function deserializeSnapshot(snapshot: DurableFileSnapshot): FileSnapshot {
  if (!snapshot.existed) return { existed: false };
  return {
    existed: true,
    contents: Buffer.from(snapshot.contents!, 'base64'),
    mode: snapshot.mode,
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
  };
}

function desiredVersion(contents: Buffer, mode: number): DesiredFileVersion {
  return { mode, size: contents.length, sha256: hashBytes(contents) };
}

function snapshotMatchesDurable(snapshot: FileSnapshot, durable: DurableFileSnapshot): boolean {
  return snapshot.existed === durable.existed && (!snapshot.existed || (
    snapshot.mode === durable.mode && snapshot.dev === durable.dev && snapshot.ino === durable.ino &&
    snapshot.size === durable.size && snapshot.mtimeMs === durable.mtimeMs &&
    hashBytes(snapshot.contents!) === durable.sha256
  ));
}

function snapshotMatchesDesired(snapshot: FileSnapshot, desired: DesiredFileVersion): boolean {
  return snapshot.existed && snapshot.mode === desired.mode && snapshot.size === desired.size &&
    hashBytes(snapshot.contents!) === desired.sha256;
}

function validDurableSnapshot(value: unknown): value is DurableFileSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<DurableFileSnapshot>;
  if (snapshot.existed === false) return true;
  return snapshot.existed === true && typeof snapshot.contents === 'string' &&
    Number.isFinite(snapshot.mode) && Number.isFinite(snapshot.dev) &&
    Number.isFinite(snapshot.ino) && Number.isFinite(snapshot.size) &&
    Number.isFinite(snapshot.mtimeMs) && typeof snapshot.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(snapshot.sha256);
}

function validDesiredVersion(value: unknown): value is DesiredFileVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const desired = value as Partial<DesiredFileVersion>;
  return Number.isFinite(desired.mode) && Number.isFinite(desired.size) &&
    typeof desired.sha256 === 'string' && /^[0-9a-f]{64}$/.test(desired.sha256);
}

function isGlobalSetupTransactionPhase(value: unknown): value is GlobalSetupTransactionPhase {
  return value === 'prepared' || value === 'config-committing' || value === 'config-written' ||
    value === 'marker-committing' || value === 'marker-written' || value === 'ambiguous';
}

function globalSetupTransactionOwnerIsActive(token: string): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return activeGlobalSetupTransactions.has(token);
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeCoordinatorPath(receiptPath: string): void {
  fs.unlinkSync(receiptPath);
  fsyncDirectory(path.dirname(receiptPath));
}

function hashBytes(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/** Capture one stable regular file without following a raced final symlink. */
function snapshotFile(target: string, maxBytes: number): FileSnapshot {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`Unsafe global setup file: ${target}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`Invalid global setup snapshot limit: ${maxBytes}`);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFilesystemEntry(pathStat, opened)) {
      throw new Error(`Unsafe global setup file: ${target}`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`Global setup file exceeds ${maxBytes} bytes: ${target}`);
    }

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`Global setup file changed while reading: ${target}`);
      offset += bytesRead;
    }

    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameStableFile(opened, afterRead) ||
        afterPath.isSymbolicLink() || !afterPath.isFile() ||
        !sameStableFile(opened, afterPath)) {
      throw new Error(`Global setup file changed while reading: ${target}`);
    }
    return {
      existed: true,
      contents,
      mode: opened.mode & 0o777,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeFileWithExpectedVersion(
  target: string,
  expected: FileSnapshot,
  maxBytes: number,
  writeExclusive: () => void,
  coordinator: ActiveGlobalSetupTransaction,
): void {
  const claimToken = `${process.pid}.${crypto.randomBytes(12).toString('hex')}`;
  const claim = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${claimToken}.claim`,
  );
  const receipt = expected.existed
    ? writeGlobalClaimReceipt(target, claim, claimToken, expected, coordinator.value.token)
    : undefined;
  let claimed: FileSnapshot | undefined;
  try {
    globalSetupCommitHookForTests?.({
      stage: 'before-write-claim',
      target,
      quarantine: claim,
    });

    if (expected.existed) {
      assertGlobalClaimReceipt(receipt!);
      fs.renameSync(target, claim);
      fsyncDirectory(path.dirname(target));
      claimed = snapshotFile(claim, maxBytes);
      if (!snapshotsMatchAcrossRename(expected, claimed)) {
        const recovery = restoreUnexpectedMovedFile(target, claim, maxBytes);
        if (recovery.restored) removeGlobalClaimReceipt(receipt!);
        throw new Error(`Setup file changed immediately before save; the concurrent version was ${recovery.message}.`);
      }
      globalSetupCommitHookForTests?.({
        stage: 'after-write-claim',
        target,
        quarantine: claim,
      });
    }

    try {
      writeExclusive();
      if (!snapshotFile(target, maxBytes).existed) {
        throw new Error(`Setup writer reported success without creating ${target}.`);
      }
      globalSetupCommitHookForTests?.({
        stage: 'after-write-replacement',
        target,
        quarantine: claim,
      });
    } catch (error) {
      if (claimed) {
        const recovery = restoreUnexpectedMovedFile(target, claim, maxBytes);
        if (recovery.restored) Object.assign(expected, recovery.restored);
        if (recovery.restored) removeGlobalClaimReceipt(receipt!);
      }
      throw error;
    }

    if (claimed) {
      const verifiedClaim = snapshotFile(claim, maxBytes);
      if (!snapshotsAreExact(claimed, verifiedClaim)) {
        throw new Error(`Setup file claim changed during save and is preserved at ${claim}.`);
      }
      fs.unlinkSync(claim);
      fsyncDirectory(path.dirname(claim));
      removeGlobalClaimReceipt(receipt!);
    }
  } finally {
    if (receipt) activeGlobalClaimTokens.delete(receipt.token);
  }
}

interface GlobalClaimReceipt {
  version: 1;
  phase: 'prepared' | 'ambiguous';
  target: string;
  claim: string;
  token: string;
  /** Links the claimed pre-state to the durable two-file setup coordinator. */
  coordinatorToken?: string;
  expected: {
    mode: number;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    sha256: string;
  };
}

const GLOBAL_CLAIM_RECEIPT_MAX_BYTES = 16 * 1024;
const GLOBAL_CLAIM_RECEIPT_LIMIT = 64;
const activeGlobalClaimTokens = new Set<string>();

interface ActiveGlobalClaimReceipt {
  path: string;
  target: string;
  claim: string;
  token: string;
}

function writeGlobalClaimReceipt(
  target: string,
  claim: string,
  token: string,
  expected: FileSnapshot,
  coordinatorToken: string,
): ActiveGlobalClaimReceipt {
  const receiptPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${token}.claim-receipt.json`,
  );
  const receipt: GlobalClaimReceipt = {
    version: 1,
    phase: 'prepared',
    target,
    claim,
    token,
    coordinatorToken,
    expected: {
      mode: expected.mode!,
      dev: expected.dev!,
      ino: expected.ino!,
      size: expected.size!,
      mtimeMs: expected.mtimeMs!,
      sha256: crypto.createHash('sha256').update(expected.contents!).digest('hex'),
    },
  };
  activeGlobalClaimTokens.add(token);
  try {
    writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
      exclusive: true,
    });
  } catch (error) {
    activeGlobalClaimTokens.delete(token);
    throw error;
  }
  return { path: receiptPath, target, claim, token };
}

function assertGlobalClaimReceipt(active: ActiveGlobalClaimReceipt): void {
  const receipt = readGlobalClaimReceipt(active.path, active.target, active.token);
  if (!receipt || receipt.phase !== 'prepared' || receipt.claim !== active.claim) {
    throw new Error('Global setup transaction receipt changed before claim.');
  }
}

function recoverInterruptedGlobalClaims(
  target: string,
  maxBytes: number,
  coordinatorPaths?: { configPath: string; markerPath: string },
): void {
  const directory = path.dirname(target);
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Unsafe global setup transaction directory: ${directory}`);
  }

  const escapedBase = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiptName = new RegExp(
    `^\\.${escapedBase}\\.([0-9]+\\.[0-9a-f]{24})\\.claim-receipt\\.json$`,
  );
  const entries = fs.readdirSync(directory)
    .map((name) => ({ name, match: receiptName.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => !!entry.match)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > GLOBAL_CLAIM_RECEIPT_LIMIT) {
    throw new Error(`Too many pending setup transactions for ${target}; manual recovery is required.`);
  }
  for (const { name, match } of entries) {
    const receiptPath = path.join(directory, name);
    const receipt = readGlobalClaimReceipt(receiptPath, target, match[1]!);
    if (!receipt || globalClaimOwnerIsActive(receipt.token)) continue;
    const claim = snapshotFile(receipt.claim, maxBytes);
    const current = snapshotFile(target, maxBytes);
    if (!claim.existed) {
      if (current.existed) removeGlobalClaimReceipt(receiptPath);
      continue;
    }
    if (!snapshotMatchesGlobalClaimReceipt(claim, receipt)) continue;
    if (coordinatorPaths && globalCoordinatorOwnsClaimReplacement(
      receipt,
      claim,
      current,
      coordinatorPaths.configPath,
      coordinatorPaths.markerPath,
    )) {
      fs.unlinkSync(receipt.claim);
      fsyncDirectory(directory);
      removeGlobalClaimReceipt(receiptPath);
      continue;
    }
    if (receipt.phase === 'ambiguous') continue;
    if (current.existed) {
      if (snapshotsAreExact(claim, current)) {
        fs.unlinkSync(receipt.claim);
        fsyncDirectory(directory);
        removeGlobalClaimReceipt(receiptPath);
        continue;
      }
      // A failed writer can leave an unowned partial at the canonical path.
      // No committed-replacement receipt exists, so both versions must remain.
      writeFileAtomic(receiptPath, `${JSON.stringify({ ...receipt, phase: 'ambiguous' })}\n`, {
        mode: 0o600,
      });
      continue;
    }
    fs.linkSync(receipt.claim, target);
    fsyncDirectory(directory);
    const claimAfterLink = snapshotFile(receipt.claim, maxBytes);
    const restored = snapshotFile(target, maxBytes);
    if (!snapshotsAreExact(claimAfterLink, restored)) {
      throw new Error(`Setup claim could not be restored safely: ${receipt.claim}`);
    }
    fs.unlinkSync(receipt.claim);
    fsyncDirectory(directory);
    removeGlobalClaimReceipt(receiptPath);
  }
}

function readGlobalClaimReceipt(
  receiptPath: string,
  target: string,
  token: string,
): GlobalClaimReceipt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      snapshotFile(receiptPath, GLOBAL_CLAIM_RECEIPT_MAX_BYTES).contents!.toString('utf8'),
    );
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const receipt = parsed as Partial<GlobalClaimReceipt>;
  const expected = receipt.expected;
  if (receipt.version !== 1 ||
      (receipt.phase !== 'prepared' && receipt.phase !== 'ambiguous') ||
      receipt.target !== target || receipt.token !== token ||
      (receipt.coordinatorToken !== undefined &&
        (typeof receipt.coordinatorToken !== 'string' ||
          !/^[0-9]+\.[0-9a-f]{24}$/.test(receipt.coordinatorToken))) ||
      typeof receipt.claim !== 'string' || path.dirname(receipt.claim) !== path.dirname(target) ||
      path.basename(receipt.claim) !== `.${path.basename(target)}.${token}.claim` ||
      !expected || typeof expected !== 'object' ||
      !Number.isFinite(expected.mode) || !Number.isFinite(expected.dev) ||
      !Number.isFinite(expected.ino) || !Number.isFinite(expected.size) ||
      !Number.isFinite(expected.mtimeMs) ||
      typeof expected.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    return undefined;
  }
  return receipt as GlobalClaimReceipt;
}

/**
 * A replacement is owned when the claim is the coordinator's exact pre-state
 * and the canonical path is the coordinator's deterministic desired version.
 * This proof survives death after the exclusive write but before claim cleanup.
 */
function globalCoordinatorOwnsClaimReplacement(
  claimReceipt: GlobalClaimReceipt,
  claim: FileSnapshot,
  current: FileSnapshot,
  configPath: string,
  markerPath: string,
): boolean {
  const coordinatorToken = claimReceipt.coordinatorToken;
  if (!coordinatorToken) return false;
  const fileName = `.global-setup.${coordinatorToken}.txn.json`;
  const receiptPath = path.join(path.dirname(configPath), fileName);
  const coordinator = readGlobalSetupTransaction(
    receiptPath,
    configPath,
    markerPath,
    fileName,
  );
  if (!coordinator || coordinator.phase === 'ambiguous' ||
      globalSetupTransactionOwnerIsActive(coordinator.token)) {
    return false;
  }

  if (claimReceipt.target === configPath) {
    return coordinator.phase !== 'prepared' &&
      snapshotMatchesDurable(claim, coordinator.configBefore) &&
      snapshotMatchesDesired(current, coordinator.desiredConfig);
  }
  if (claimReceipt.target === markerPath) {
    return (coordinator.phase === 'marker-committing' || coordinator.phase === 'marker-written') &&
      snapshotMatchesDurable(claim, coordinator.markerBefore) &&
      snapshotMatchesDesired(current, coordinator.desiredMarker);
  }
  return false;
}

function snapshotMatchesGlobalClaimReceipt(
  snapshot: FileSnapshot,
  receipt: GlobalClaimReceipt,
): boolean {
  return snapshot.existed &&
    snapshot.mode === receipt.expected.mode &&
    snapshot.dev === receipt.expected.dev &&
    snapshot.ino === receipt.expected.ino &&
    snapshot.size === receipt.expected.size &&
    snapshot.mtimeMs === receipt.expected.mtimeMs &&
    crypto.createHash('sha256').update(snapshot.contents!).digest('hex') === receipt.expected.sha256;
}

function globalClaimOwnerIsActive(token: string): boolean {
  const ownerPid = Number(token.slice(0, token.indexOf('.')));
  if (ownerPid === process.pid) return activeGlobalClaimTokens.has(token);
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeGlobalClaimReceipt(receipt: string | ActiveGlobalClaimReceipt): void {
  const receiptPath = typeof receipt === 'string' ? receipt : receipt.path;
  if (typeof receipt !== 'string') assertGlobalClaimReceipt(receipt);
  fs.unlinkSync(receiptPath);
  fsyncDirectory(path.dirname(receiptPath));
}

/**
 * Restore only a version a completed writer proved it owned. A writer that
 * throws after touching disk has no ownership receipt, so preserving that path
 * and surfacing rollback-incomplete is safer than deleting concurrent state.
 */
function rollbackFile(
  target: string,
  before: FileSnapshot,
  stage: FileWriteStage,
  maxBytes: number,
): Error | undefined {
  if (!stage.attempted) return undefined;

  let current: FileSnapshot;
  try {
    current = snapshotFile(target, maxBytes);
  } catch (error) {
    return new Error(
      `Refusing to roll back ${target} because its current version cannot be verified: ${errorMessage(error)}`,
    );
  }

  if (snapshotsAreExact(before, current)) return undefined;
  if (!stage.completed || !stage.after) {
    return new Error(`Refusing to roll back ${target}: a failing writer changed it without an ownership receipt.`);
  }
  if (!snapshotsAreExact(stage.after, current)) {
    return new Error(`Refusing to roll back ${target}: a concurrent writer replaced the committed version.`);
  }

  try {
    if (!before.existed) {
      return removeOwnedFileVersion(target, stage.after, maxBytes);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileAtomic(target, before.contents!, {
      mode: before.mode,
      beforeCommit: () => {
        const latest = snapshotFile(target, maxBytes);
        if (!snapshotsAreExact(stage.after!, latest)) {
          throw new Error(`Concurrent write detected while rolling back ${target}.`);
        }
      },
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function removeOwnedFileVersion(
  target: string,
  expected: FileSnapshot,
  maxBytes: number,
): Error | undefined {
  const quarantine = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.rollback`,
  );
  try {
    globalSetupRollbackHookForTests?.({
      stage: 'before-remove-quarantine',
      target,
      quarantine,
    });
    fs.renameSync(target, quarantine);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    return new Error(`Refusing to remove ${target} during rollback: ${errorMessage(error)}`);
  }

  let moved: FileSnapshot;
  try {
    moved = snapshotFile(quarantine, maxBytes);
  } catch (error) {
    return new Error(
      `Refusing to remove ${target}; the quarantined version is preserved at ${quarantine}: ${errorMessage(error)}`,
    );
  }

  if (!snapshotsMatchAcrossRename(expected, moved)) {
    const recovery = restoreUnexpectedMovedFile(target, quarantine, maxBytes);
    return new Error(
      `Refusing to remove ${target}: a concurrent replacement was moved during rollback (${recovery.message}).`,
    );
  }

  let concurrentTarget: FileSnapshot;
  try {
    concurrentTarget = snapshotFile(target, maxBytes);
    const verifiedMoved = snapshotFile(quarantine, maxBytes);
    if (!snapshotsAreExact(moved, verifiedMoved)) {
      return new Error(`Refusing to remove ${target}; its rollback quarantine changed at ${quarantine}.`);
    }
    fs.unlinkSync(quarantine);
    fsyncDirectory(path.dirname(quarantine));
  } catch (error) {
    return new Error(
      `Refusing to finish removal of ${target}; its rollback quarantine is preserved at ${quarantine}: ${errorMessage(error)}`,
    );
  }
  return concurrentTarget.existed
    ? new Error(`Rollback removed its owned ${target} version, but a concurrent writer created a replacement.`)
    : undefined;
}

function restoreUnexpectedMovedFile(
  target: string,
  quarantine: string,
  maxBytes: number,
): { message: string; restored?: FileSnapshot } {
  try {
    const current = snapshotFile(target, maxBytes);
    if (current.existed) {
      return { message: `preserved at ${quarantine}; the canonical path is already occupied` };
    }
    fs.linkSync(quarantine, target);
    fsyncDirectory(path.dirname(target));
    const movedAfterLink = snapshotFile(quarantine, maxBytes);
    const restored = snapshotFile(target, maxBytes);
    if (!snapshotsAreExact(movedAfterLink, restored)) {
      return { message: `preserved at ${quarantine}; the restored link could not be verified` };
    }
    fs.unlinkSync(quarantine);
    fsyncDirectory(path.dirname(quarantine));
    return {
      message: 'restored to the canonical path',
      restored: snapshotFile(target, maxBytes),
    };
  } catch (error) {
    return { message: `preserved at ${quarantine}; ${errorMessage(error)}` };
  }
}

function snapshotsAreExact(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.existed !== right.existed) return false;
  if (!left.existed) return true;
  return left.mode === right.mode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.contents!.equals(right.contents!);
}

function snapshotsMatchAcrossRename(left: FileSnapshot, right: FileSnapshot): boolean {
  if (!left.existed || !right.existed) return false;
  return left.mode === right.mode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.contents!.equals(right.contents!);
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFilesystemEntry(left, right) &&
    (left.mode & 0o777) === (right.mode & 0o777) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeEmptyDirectory(directory: string): Error | undefined {
  try {
    fs.rmdirSync(directory);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return undefined;
    return error instanceof Error ? error : new Error(String(error));
  }
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
