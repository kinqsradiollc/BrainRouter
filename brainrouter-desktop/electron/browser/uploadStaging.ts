import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_PATH_CHARS = 4_096;
const COPY_CHUNK_BYTES = 1024 * 1024;

export type UploadStagingErrorCode = 'INVALID_REQUEST' | 'DENIED' | 'TOO_LARGE' | 'CANCELLED' | 'INTERNAL';

export class UploadStagingError extends Error {
  constructor(readonly code: UploadStagingErrorCode, message: string) {
    super(message);
    this.name = 'UploadStagingError';
  }
}

export interface StagedWorkspaceUpload {
  /** App-temporary directory. Never points at or contains the source workspace. */
  directory: string;
  /** Staged absolute files for Chromium; source paths are never returned. */
  files: string[];
  /** Idempotent lifecycle cleanup. */
  cleanup(): void;
}

export interface StageWorkspaceUploadOptions {
  workspaceRoot: string;
  tempRoot: string;
  files: readonly unknown[];
  signal?: AbortSignal;
  /** Deterministic race injection used only by the pure Node security tests. */
  testHooks?: {
    afterCopyChunk?(event: { fileIndex: number; copiedBytes: number }): void | Promise<void>;
  };
}

type Fingerprint = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type DirectoryRecord = {
  path: string;
  fingerprint: Fingerprint;
};

type SourceRecord = {
  path: string;
  basename: string;
  fingerprint: Fingerprint;
  handle?: FileHandle;
};

type DestinationRecord = {
  path: string;
  directory: string;
  basename: string;
  handle: FileHandle;
  fingerprint: Fingerprint;
};

function stagingError(code: UploadStagingErrorCode, message: string): UploadStagingError {
  return new UploadStagingError(code, message);
}

function sanitizedStagingError(error: unknown, signal?: AbortSignal): UploadStagingError {
  if (error instanceof UploadStagingError) return error;
  if (signal?.aborted) return stagingError('CANCELLED', 'Upload staging was cancelled.');
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
    return stagingError('DENIED', 'Upload source failed secure workspace validation.');
  }
  if (code === 'ENOENT') return stagingError('INVALID_REQUEST', 'An upload source is unavailable.');
  return stagingError('INTERNAL', 'Upload files could not be staged securely.');
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw stagingError('CANCELLED', 'Upload staging was cancelled.');
}

function fingerprint(stat: BigIntStats): Fingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: Fingerprint, right: Fingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: Fingerprint, right: Fingerprint): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameStableDirectory(left: Fingerprint, right: Fingerprint): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRelativeUploadPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_UPLOAD_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw stagingError('INVALID_REQUEST', 'An upload source path is invalid.');
  }
  const portable = value.trim().replace(/\\/g, '/');
  if (!portable || path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)
    || /^[a-zA-Z]:/.test(portable) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(portable)) {
    throw stagingError('DENIED', 'Upload sources must be workspace-relative files.');
  }
  const segments: string[] = [];
  for (const segment of portable.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw stagingError('DENIED', 'Upload sources cannot traverse outside the workspace.');
    segments.push(segment);
  }
  if (!segments.length) throw stagingError('INVALID_REQUEST', 'An upload source path is invalid.');
  return segments.join('/');
}

/**
 * Cooperative cancellation checkpoint for the staging pipeline.
 *
 * This used to also fs.watch the source + staging directories and fail closed on
 * any event. That was removed: an fs.watch armed on a tree we (or the caller)
 * just touched is racy by construction — macOS FSEvents delivers the *creation*
 * events for the source files and the staging tree AFTER the watcher arms, so
 * the guard tripped on its own/the caller's setup and failed legitimate uploads
 * intermittently (only on macOS; inotify on Linux delivers synchronously and hid
 * it). It was also redundant: TOCTOU safety is guaranteed authoritatively by the
 * fingerprint + full-content re-hash + realpath containment re-validation in
 * `copyAndVerify`, `validateSourceRecord`, and `validateDirectoryRecords`, which
 * catch source swaps, in-place mutation, and ancestor rename/restore regardless
 * of any filesystem-event notification.
 */
class MutationGuard {
  assertUnchanged(signal?: AbortSignal): void {
    assertNotCancelled(signal);
  }

  async settle(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.assertUnchanged(signal);
  }

  close(): void { /* no watchers to release */ }
}

async function lstatBig(candidate: string): Promise<BigIntStats> {
  return fs.promises.lstat(candidate, { bigint: true });
}

async function validateDirectoryRecords(records: Iterable<DirectoryRecord>, workspace: string): Promise<void> {
  for (const record of records) {
    const stat = await lstatBig(record.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameStableDirectory(record.fingerprint, fingerprint(stat))) {
      throw stagingError('DENIED', 'An upload source directory changed during secure staging.');
    }
    const canonical = await fs.promises.realpath(record.path);
    if (canonical !== record.path || !isInside(workspace, canonical)) {
      throw stagingError('DENIED', 'An upload source directory failed canonical containment.');
    }
  }
}

async function validateSourceRecord(record: SourceRecord, workspace: string): Promise<void> {
  const pathStat = await lstatBig(record.path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameStableFile(record.fingerprint, fingerprint(pathStat))) {
    throw stagingError('DENIED', 'An upload source changed during secure staging.');
  }
  const canonical = await fs.promises.realpath(record.path);
  if (canonical !== record.path || !isInside(workspace, canonical)) {
    throw stagingError('DENIED', 'An upload source failed canonical containment.');
  }
  if (record.handle) {
    const handleStat = await record.handle.stat({ bigint: true });
    if (!handleStat.isFile() || !sameStableFile(record.fingerprint, fingerprint(handleStat))) {
      throw stagingError('DENIED', 'An upload source changed during secure staging.');
    }
  }
}

async function discoverSources(workspaceRoot: string, relativeFiles: string[]): Promise<{
  workspace: string;
  directories: Map<string, DirectoryRecord>;
  sources: SourceRecord[];
}> {
  const workspace = await fs.promises.realpath(workspaceRoot);
  const rootStat = await lstatBig(workspace);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw stagingError('DENIED', 'The active workspace failed secure validation.');

  const directories = new Map<string, DirectoryRecord>();
  const addDirectory = (directory: string, stat: BigIntStats): DirectoryRecord => {
    const existing = directories.get(directory);
    if (existing) return existing;
    const record = { path: directory, fingerprint: fingerprint(stat) };
    directories.set(directory, record);
    return record;
  };
  addDirectory(workspace, rootStat);
  const sources: SourceRecord[] = [];

  for (const relative of relativeFiles) {
    const segments = relative.split('/');
    let current = workspace;
    for (const segment of segments.slice(0, -1)) {
      const candidate = path.join(current, segment);
      const stat = await lstatBig(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw stagingError('DENIED', 'Upload source ancestors must be real workspace directories.');
      const canonical = await fs.promises.realpath(candidate);
      if (!isInside(workspace, canonical) || path.dirname(canonical) !== current) throw stagingError('DENIED', 'Upload source ancestors failed canonical containment.');
      addDirectory(canonical, stat);
      current = canonical;
    }

    const requestedName = segments.at(-1)!;
    const candidate = path.join(current, requestedName);
    const pathStat = await lstatBig(candidate);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw stagingError('DENIED', 'Upload sources must be regular workspace files, not links.');
    const canonical = await fs.promises.realpath(candidate);
    if (!isInside(workspace, canonical) || path.dirname(canonical) !== current) throw stagingError('DENIED', 'An upload source failed canonical containment.');
    const canonicalStat = await lstatBig(canonical);
    if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile() || !sameIdentity(fingerprint(pathStat), fingerprint(canonicalStat))) {
      throw stagingError('DENIED', 'An upload source changed during secure validation.');
    }
    sources.push({ path: canonical, basename: path.basename(canonical), fingerprint: fingerprint(canonicalStat) });
  }
  return { workspace, directories, sources };
}

async function openSources(sources: SourceRecord[], workspace: string, guard: MutationGuard, signal?: AbortSignal): Promise<void> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const source of sources) {
    guard.assertUnchanged(signal);
    source.handle = await fs.promises.open(source.path, fs.constants.O_RDONLY | noFollow);
    await validateSourceRecord(source, workspace);
  }
}

async function createDestinations(tempRoot: string, sources: SourceRecord[]): Promise<{
  stagingRoot: string;
  destinations: DestinationRecord[];
}> {
  const canonicalTemp = await fs.promises.realpath(tempRoot);
  const tempStat = await lstatBig(canonicalTemp);
  if (tempStat.isSymbolicLink() || !tempStat.isDirectory()) throw stagingError('DENIED', 'The upload staging location is unavailable.');
  const stagingRoot = await fs.promises.mkdtemp(path.join(canonicalTemp, 'brainrouter-browser-upload-'));
  await fs.promises.chmod(stagingRoot, 0o700);
  const stagingStat = await lstatBig(stagingRoot);
  const canonicalStaging = await fs.promises.realpath(stagingRoot);
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory() || path.dirname(canonicalStaging) !== canonicalTemp) {
    throw stagingError('DENIED', 'The upload staging location failed secure validation.');
  }

  const destinations: DestinationRecord[] = [];
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const itemDirectory = path.join(canonicalStaging, `${index}-${randomUUID().replace(/-/g, '').slice(0, 12)}`);
    await fs.promises.mkdir(itemDirectory, { mode: 0o700 });
    await fs.promises.chmod(itemDirectory, 0o700);
    const itemStat = await lstatBig(itemDirectory);
    if (itemStat.isSymbolicLink() || !itemStat.isDirectory() || path.dirname(await fs.promises.realpath(itemDirectory)) !== canonicalStaging) {
      throw stagingError('DENIED', 'The upload staging location changed unexpectedly.');
    }
    const destination = path.join(itemDirectory, source.basename);
    const handle = await fs.promises.open(destination, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    await handle.chmod(0o600);
    const destinationStat = await handle.stat({ bigint: true });
    if (!destinationStat.isFile() || destinationStat.nlink !== 1n) {
      await handle.close().catch(() => undefined);
      throw stagingError('DENIED', 'A staged upload target failed secure validation.');
    }
    destinations.push({
      path: destination,
      directory: itemDirectory,
      basename: source.basename,
      handle,
      fingerprint: fingerprint(destinationStat),
    });
  }
  return { stagingRoot: canonicalStaging, destinations };
}

async function hashHandle(handle: FileHandle, expectedBytes: number, guard: MutationGuard, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, expectedBytes)));
  let position = 0;
  while (position < expectedBytes) {
    guard.assertUnchanged(signal);
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) throw stagingError('DENIED', 'An upload source changed while it was being read.');
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, expectedBytes)).bytesRead !== 0) throw stagingError('DENIED', 'An upload source grew while it was being read.');
  return digest.digest('hex');
}

async function copyAndVerify(
  source: SourceRecord,
  destination: DestinationRecord,
  fileIndex: number,
  guard: MutationGuard,
  options: StageWorkspaceUploadOptions,
): Promise<void> {
  const sourceHandle = source.handle!;
  const expectedBytes = Number(source.fingerprint.size);
  const sourceDigest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, expectedBytes)));
  let position = 0;
  while (position < expectedBytes) {
    guard.assertUnchanged(options.signal);
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
    if (bytesRead <= 0) throw stagingError('DENIED', 'An upload source changed while it was being copied.');
    sourceDigest.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.handle.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten <= 0) throw stagingError('INTERNAL', 'A staged upload write did not make progress.');
      written += result.bytesWritten;
    }
    position += bytesRead;
    if (options.testHooks?.afterCopyChunk) await options.testHooks.afterCopyChunk({ fileIndex, copiedBytes: position });
    guard.assertUnchanged(options.signal);
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await sourceHandle.read(extra, 0, 1, expectedBytes)).bytesRead !== 0) throw stagingError('DENIED', 'An upload source grew while it was being copied.');
  await destination.handle.sync();

  const sourceAfterCopy = await sourceHandle.stat({ bigint: true });
  if (!sourceAfterCopy.isFile() || !sameStableFile(source.fingerprint, fingerprint(sourceAfterCopy))) {
    throw stagingError('DENIED', 'An upload source changed while it was being copied.');
  }
  const verificationDigest = await hashHandle(sourceHandle, expectedBytes, guard, options.signal);
  if (verificationDigest !== sourceDigest.digest('hex')) throw stagingError('DENIED', 'Upload source content changed during secure staging.');
  const destinationDigest = await hashHandle(destination.handle, expectedBytes, guard, options.signal);
  if (destinationDigest !== verificationDigest) throw stagingError('INTERNAL', 'A staged upload failed content verification.');

  const destinationStat = await destination.handle.stat({ bigint: true });
  const currentPathStat = await lstatBig(destination.path);
  if (!destinationStat.isFile() || destinationStat.nlink !== 1n || currentPathStat.isSymbolicLink() || !currentPathStat.isFile()
    || !sameIdentity(destination.fingerprint, fingerprint(destinationStat))
    || !sameIdentity(destination.fingerprint, fingerprint(currentPathStat))
    || destinationStat.size !== BigInt(expectedBytes)) {
    throw stagingError('DENIED', 'A staged upload target changed unexpectedly.');
  }
}

function cleanupDirectory(directory: string): void {
  if (!directory) return;
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
}

export async function stageWorkspaceUploadFiles(options: StageWorkspaceUploadOptions): Promise<StagedWorkspaceUpload> {
  if (!Array.isArray(options.files) || options.files.length < 1 || options.files.length > MAX_UPLOAD_FILES) {
    throw stagingError('INVALID_REQUEST', `Upload requires between 1 and ${MAX_UPLOAD_FILES} workspace files.`);
  }
  const relativeFiles = options.files.map(normalizeRelativeUploadPath);
  const guard = new MutationGuard();
  let stagingRoot = '';
  let sources: SourceRecord[] = [];
  let destinations: DestinationRecord[] = [];
  let completed = false;

  try {
    assertNotCancelled(options.signal);
    const discovered = await discoverSources(options.workspaceRoot, relativeFiles);
    sources = discovered.sources;
    await validateDirectoryRecords(discovered.directories.values(), discovered.workspace);
    guard.assertUnchanged(options.signal);
    await openSources(sources, discovered.workspace, guard, options.signal);

    let totalBytes = 0n;
    for (const source of sources) {
      if (source.fingerprint.size > BigInt(MAX_UPLOAD_FILE_BYTES)) throw stagingError('TOO_LARGE', 'An upload source exceeds the 512 MiB per-file limit.');
      totalBytes += source.fingerprint.size;
      if (totalBytes > BigInt(MAX_UPLOAD_TOTAL_BYTES)) throw stagingError('TOO_LARGE', 'Upload sources exceed the 1 GiB total limit.');
    }

    const staged = await createDestinations(options.tempRoot, sources);
    stagingRoot = staged.stagingRoot;
    destinations = staged.destinations;
    // NB: we deliberately do NOT fs.watch the staging tree. A watch armed on a
    // directory we then populate is racy by construction — macOS FSEvents
    // delivers the staging-root/item-dir/dest-file *creation* events AFTER the
    // watcher arms, so the guard trips on its own setup (a false "source
    // changed" on every run). It is also redundant: the destination is created
    // with O_EXCL+0600 and held by an open fd, and copyAndVerify re-verifies
    // each target authoritatively (open-fd stat vs path stat fingerprint
    // identity, nlink===1, size) — path swaps and replacements are caught there,
    // and the final realpath containment check below re-confirms each target.
    guard.assertUnchanged(options.signal);

    for (let index = 0; index < sources.length; index += 1) {
      await copyAndVerify(sources[index], destinations[index], index, guard, options);
    }

    await validateDirectoryRecords(discovered.directories.values(), discovered.workspace);
    for (const source of sources) await validateSourceRecord(source, discovered.workspace);
    await guard.settle(options.signal);

    const files: string[] = [];
    for (const destination of destinations) {
      const canonical = await fs.promises.realpath(destination.path);
      if (!isInside(stagingRoot, canonical) || path.dirname(canonical) !== destination.directory) {
        throw stagingError('DENIED', 'A staged upload target failed canonical containment.');
      }
      files.push(canonical);
    }
    completed = true;
    let cleaned = false;
    return {
      directory: stagingRoot,
      files,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        cleanupDirectory(stagingRoot);
      },
    };
  } catch (error) {
    throw sanitizedStagingError(error, options.signal);
  } finally {
    guard.close();
    await Promise.allSettled(sources.map((source) => source.handle?.close()));
    await Promise.allSettled(destinations.map((destination) => destination.handle.close()));
    if (!completed) cleanupDirectory(stagingRoot);
  }
}
