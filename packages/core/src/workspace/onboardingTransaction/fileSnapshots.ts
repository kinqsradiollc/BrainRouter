/**
 * Workspace-onboarding file snapshot and encoding adapter.
 *
 * A25-5b: owns descriptor-anchored reads, exact identity comparisons, bounded
 * encodings, and receipt-version validation independently of transaction
 * orchestration. This is a behavior-preserving extraction from the coordinator.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  openWorkspaceFileParentGuard,
  type WorkspaceFileParentGuard,
  type WorkspaceFileStagedVersion,
} from '../fileWrite.js';
import {
  INSTRUCTION_MAX_BYTES,
  type DesiredFileVersion,
  type EncodedFileSnapshot,
  type EncodedFileVersion,
  type StagedFileVersion,
  type WorkspaceOnboardingFileSnapshot,
} from './contracts.js';

export function normalizeProvidedSnapshot(
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

export function desiredVersion(
  contents: string | Buffer,
  maxBytes: number,
  label: string,
): DesiredFileVersion {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return { size: bytes.length, sha256: sha256(bytes) };
}

export function encodeSnapshot(
  snapshot: WorkspaceOnboardingFileSnapshot,
): EncodedFileSnapshot {
  if (!snapshot.existed) return { existed: false };
  return {
    existed: true,
    ...encodeVersion(snapshot),
    contentsBase64: snapshot.contents!.toString('base64'),
  };
}

export function encodeVersion(
  snapshot: WorkspaceOnboardingFileSnapshot,
): EncodedFileVersion {
  if (!snapshot.existed || !snapshot.contents) {
    throw new Error('Cannot encode an absent workspace file.');
  }
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

export function encodeStagedVersion(
  staged: WorkspaceFileStagedVersion,
): StagedFileVersion {
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

export function snapshotWorkspaceFile(
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

export function snapshotWorkspaceSibling(
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

export function snapshotRegularFile(
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
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`Unsafe ${label}: ${target}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFilesystemEntry(pathStat, opened) ||
        opened.size > maxBytes) {
      throw new Error(`Unsafe ${label}: ${target}`);
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = fs.readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (read <= 0) throw new Error(`${label} changed while reading: ${target}`);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameStableFile(opened, after) || afterPath.isSymbolicLink() ||
        !afterPath.isFile() || !sameStableFile(after, afterPath)) {
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

export function snapshotsAreExact(
  left: WorkspaceOnboardingFileSnapshot,
  right: WorkspaceOnboardingFileSnapshot,
): boolean {
  return left.existed === right.existed && (!left.existed || (
    left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.contents!.equals(right.contents!)
  ));
}

export function snapshotMatchesEncodedSnapshot(
  snapshot: WorkspaceOnboardingFileSnapshot,
  expected: EncodedFileSnapshot,
): boolean {
  if (snapshot.existed !== expected.existed) return false;
  if (!snapshot.existed) return true;
  return snapshotMatchesVersion(snapshot, expected as EncodedFileVersion, true);
}

export function snapshotMatchesVersion(
  snapshot: WorkspaceOnboardingFileSnapshot,
  expected: EncodedFileVersion,
  compareCtime: boolean,
): boolean {
  return snapshot.existed && snapshot.mode === expected.mode &&
    snapshot.dev === expected.dev && snapshot.ino === expected.ino &&
    snapshot.size === expected.size && snapshot.mtimeMs === expected.mtimeMs &&
    (!compareCtime || expected.ctimeMs === undefined ||
      snapshot.ctimeMs === expected.ctimeMs) &&
    sha256(snapshot.contents!) === expected.sha256;
}

export function snapshotMatchesDesired(
  snapshot: WorkspaceOnboardingFileSnapshot,
  desired: DesiredFileVersion,
): boolean {
  return snapshot.existed && snapshot.size === desired.size &&
    sha256(snapshot.contents!) === desired.sha256;
}

export function decodeSnapshotContents(
  snapshot: EncodedFileSnapshot,
  maxBytes: number,
): Buffer {
  if (!snapshot.existed || typeof snapshot.contentsBase64 !== 'string') {
    throw new Error('Workspace onboarding receipt has no restorable contents.');
  }
  const contents = Buffer.from(snapshot.contentsBase64, 'base64');
  if (contents.length > maxBytes || contents.length !== snapshot.size ||
      sha256(contents) !== snapshot.sha256) {
    throw new Error('Workspace onboarding receipt contents are invalid.');
  }
  return contents;
}

export function validEncodedSnapshot(
  value: EncodedFileSnapshot,
  maxBytes: number,
): boolean {
  if (!value || typeof value !== 'object' || typeof value.existed !== 'boolean') {
    return false;
  }
  if (!value.existed) return true;
  if (!validEncodedVersion(value as EncodedFileVersion, maxBytes) ||
      typeof value.contentsBase64 !== 'string' ||
      value.contentsBase64.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    return false;
  }
  try {
    const contents = Buffer.from(value.contentsBase64, 'base64');
    return contents.length === value.size && sha256(contents) === value.sha256;
  } catch {
    return false;
  }
}

export function validEncodedVersion(
  value: EncodedFileVersion,
  maxBytes: number,
): boolean {
  return !!value && typeof value === 'object' && validMode(value.mode) &&
    validIdentityNumber(value.dev) && validIdentityNumber(value.ino) &&
    validSize(value.size, maxBytes) && validTimestamp(value.mtimeMs) &&
    (value.ctimeMs === undefined || validTimestamp(value.ctimeMs)) &&
    validHash(value.sha256);
}

export function validDesiredVersion(
  value: DesiredFileVersion,
  maxBytes: number,
): boolean {
  return !!value && typeof value === 'object' &&
    validSize(value.size, maxBytes) && validHash(value.sha256);
}

function validMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 &&
    (value as number) <= 0o777;
}

function validFilesystemMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validIdentityNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSize(value: unknown, maxBytes: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= maxBytes;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
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
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}
