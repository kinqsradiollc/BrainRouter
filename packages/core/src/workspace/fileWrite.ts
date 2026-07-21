/**
 * Workspace-confined filesystem access for BrainRouter artifacts (0.4.17).
 *
 * Resolves, reads, and atomically writes project-relative files without allowing
 * traversal or symlink escapes. Directory identity is anchored or revalidated
 * across each operation, reads are caller-bounded, and public results remain
 * canonical workspace paths even when descriptor paths are used internally.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  writeFileAtomic,
  type AtomicFileStagedVersion,
} from '../util/fs/atomicFile.js';

export interface WorkspaceFileStagedVersion extends Omit<AtomicFileStagedVersion, 'temporaryPath'> {
  /** Canonical workspace path, never a Linux `/proc/self/fd` access path. */
  temporaryPath: string;
}

export interface WorkspaceFileWriteOptions {
  mode?: number;
  /** Additional caller validation run before the final guarded commit. */
  beforeCommit?: () => void;
  /** Observe the fsynced sibling version before it is linked or renamed. */
  onStaged?: (staged: WorkspaceFileStagedVersion) => void;
  /** Commit only when the final path is still absent. */
  exclusive?: boolean;
}

export interface WorkspaceFileReadOptions {
  /** Additional caller validation run before the guarded file open. */
  beforeOpen?: () => void;
}

/**
 * A short-lived capability for sibling operations in one verified workspace
 * directory. On Linux, child paths are anchored through the open directory
 * descriptor; on other platforms every caller-controlled boundary is guarded
 * by inode checks immediately before and after the filesystem operation.
 */
export interface WorkspaceFileParentGuard {
  canonicalTarget: string;
  accessTarget: string;
  siblingPath(name: string): string;
  assertStable(): void;
  fsyncParent(): void;
  close(): void;
}

export function openWorkspaceFileParentGuard(
  workspaceRoot: string,
  relativePath: string,
  options: { createParents?: boolean; targetKind?: 'file' | 'directory' | 'any' } = {},
): WorkspaceFileParentGuard {
  const root = fs.realpathSync(workspaceRoot);
  const segments = workspacePathSegments(relativePath);
  ensureSafeParents(root, segments.slice(0, -1), { create: options.createParents });
  const parent = openWorkspaceParentGuard(root, segments.slice(0, -1));
  const fileName = segments.at(-1)!;
  const canonicalTarget = path.join(root, ...segments);
  try {
    parent.assertStable();
    assertWorkspaceTarget(parent.childPath(fileName), options.targetKind ?? 'file');
    parent.assertStable();
  } catch (error) {
    parent.close();
    throw error;
  }
  return {
    canonicalTarget,
    accessTarget: parent.childPath(fileName),
    siblingPath: (name) => {
      if (!name || name === '.' || name === '..' || name.includes('/') ||
          name.includes('\\') || name.includes('\0')) {
        throw new Error(`Unsafe workspace sibling name: ${name}`);
      }
      return parent.childPath(name);
    },
    assertStable: parent.assertStable,
    fsyncParent: parent.fsync,
    close: parent.close,
  };
}

function assertWorkspaceTarget(
  target: string,
  kind: 'file' | 'directory' | 'any',
): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() ||
        (kind === 'file' && !stat.isFile()) ||
        (kind === 'directory' && !stat.isDirectory())) {
      throw new Error(`Unsafe workspace ${kind === 'any' ? 'path' : kind}: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Read at most `maxBytes` from one regular workspace file without following its final symlink. */
export function readWorkspaceFileBounded(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
  options: WorkspaceFileReadOptions = {},
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`Invalid workspace file byte limit: ${maxBytes}`);
  }

  const root = fs.realpathSync(workspaceRoot);
  const segments = workspacePathSegments(relativePath);
  ensureSafeParents(root, segments.slice(0, -1));
  const target = path.join(root, ...segments);
  const guard = openWorkspaceParentGuard(root, segments.slice(0, -1));
  const accessTarget = guard.childPath(segments.at(-1)!);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    options.beforeOpen?.();
    guard.assertStable();
    const beforeOpen = fs.lstatSync(accessTarget);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw new Error(`Unsafe workspace file: ${relativePath}`);
    }
    descriptor = fs.openSync(accessTarget, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFilesystemEntry(beforeOpen, opened)) {
      throw new Error(`Unsafe workspace file: ${relativePath}`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`Workspace file exceeds ${maxBytes} bytes: ${relativePath}`);
    }

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`Workspace file changed while reading: ${relativePath}`);
      offset += bytesRead;
    }

    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(accessTarget);
    if (!sameStableFile(opened, afterRead) ||
        afterPath.isSymbolicLink() || !afterPath.isFile() ||
        !sameFilesystemEntry(opened, afterPath)) {
      throw new Error(`Workspace file changed while reading: ${relativePath}`);
    }
    guard.assertStable();
    return contents;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the access failure */ }
    }
    guard.close();
  }
}

/** Resolve a project-local file path while rejecting traversal and symlinks. */
export function resolveWorkspaceFileForWrite(workspaceRoot: string, relativePath: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const segments = workspacePathSegments(relativePath);
  const target = path.join(root, ...segments);
  const completeParents = ensureSafeParents(root, segments.slice(0, -1), { allowMissing: true });
  if (completeParents) {
    const guard = openWorkspaceParentGuard(root, segments.slice(0, -1));
    try {
      guard.assertStable();
      assertRegularTarget(guard.childPath(segments.at(-1)!));
      guard.assertStable();
    } finally {
      guard.close();
    }
  } else {
    assertRegularTarget(target);
  }
  return target;
}

/**
 * Same-directory atomic write for committable workspace artifacts.
 *
 * Linux exposes an opened directory through `/proc/self/fd`, so child access
 * remains anchored to that descriptor across parent-path renames. Portable
 * Node has no openat/renameat API; elsewhere we retain directory descriptors
 * and fail on identity changes immediately before and after access. A rename
 * in the final syscall-sized fallback window cannot be eliminated in Node.
 */
export function writeWorkspaceFileAtomic(
  workspaceRoot: string,
  relativePath: string,
  contents: string | Buffer,
  options: WorkspaceFileWriteOptions = {},
): string {
  const root = fs.realpathSync(workspaceRoot);
  const segments = workspacePathSegments(relativePath);
  const target = path.join(root, ...segments);
  ensureSafeParents(root, segments.slice(0, -1), { create: true });
  const guard = openWorkspaceParentGuard(root, segments.slice(0, -1));
  const accessTarget = guard.childPath(segments.at(-1)!);
  try {
    guard.assertStable();
    assertRegularTarget(accessTarget);
    writeFileAtomic(accessTarget, contents, {
      mode: options.mode,
      exclusive: options.exclusive,
      onStaged: (staged) => options.onStaged?.({
        ...staged,
        temporaryPath: path.join(path.dirname(target), path.basename(staged.temporaryPath)),
      }),
      beforeCommit: () => {
        options.beforeCommit?.();
        guard.assertStable();
        assertRegularTarget(accessTarget);
      },
    });
    guard.assertStable();
    return target;
  } finally {
    guard.close();
  }
}

/** Resolve a workspace file for reading without following project symlinks. */
export function resolveWorkspaceFileForRead(workspaceRoot: string, relativePath: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const segments = workspacePathSegments(relativePath);
  const target = path.join(root, ...segments);
  ensureSafeParents(root, segments.slice(0, -1));
  const guard = openWorkspaceParentGuard(root, segments.slice(0, -1));
  try {
    guard.assertStable();
    const stat = fs.lstatSync(guard.childPath(segments.at(-1)!));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe workspace file: ${relativePath}`);
    guard.assertStable();
    return target;
  } finally {
    guard.close();
  }
}

function workspacePathSegments(relativePath: string): string[] {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`Unsafe workspace-relative path: ${relativePath}`);
  }
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe workspace-relative path: ${relativePath}`);
  }
  return segments;
}

function ensureSafeParents(
  root: string,
  segments: string[],
  options: { create?: boolean; allowMissing?: boolean } = {},
): boolean {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.allowMissing) return false;
      if (!options.create) throw error;
      fs.mkdirSync(current, { mode: 0o755 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe workspace directory: ${path.relative(root, current)}`);
    }
  }
  return true;
}

interface GuardedDirectory {
  target: string;
  stat: fs.Stats;
  descriptor?: number;
}

interface WorkspaceParentGuard {
  childPath(name: string): string;
  assertStable(): void;
  fsync(): void;
  close(): void;
}

function openWorkspaceParentGuard(root: string, parentSegments: string[]): WorkspaceParentGuard {
  const targets = [root];
  let current = root;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    targets.push(current);
  }

  const directories: GuardedDirectory[] = [];
  try {
    for (const target of targets) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe workspace directory: ${path.relative(root, target) || '.'}`);
      }
      const descriptor = openDirectoryDescriptor(target);
      if (descriptor !== undefined) {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isDirectory() || !sameFilesystemEntry(stat, opened)) {
          fs.closeSync(descriptor);
          throw new Error(`Workspace directory changed during access: ${path.relative(root, target) || '.'}`);
        }
      }
      directories.push({ target, stat, descriptor });
    }
  } catch (error) {
    closeGuardedDirectories(directories);
    throw error;
  }

  const parent = directories.at(-1)!;
  const descriptorRoot = parent.descriptor === undefined
    ? undefined
    : descriptorDirectoryPath(parent.descriptor);
  return {
    childPath: (name) => descriptorRoot === undefined
      ? path.join(parent.target, name)
      : path.join(descriptorRoot, name),
    assertStable: () => {
      for (const directory of directories) {
        let pathStat: fs.Stats;
        try {
          pathStat = fs.lstatSync(directory.target);
        } catch {
          throw new Error(`Workspace directory changed during access: ${path.relative(root, directory.target) || '.'}`);
        }
        if (pathStat.isSymbolicLink() || !pathStat.isDirectory() ||
            !sameFilesystemEntry(directory.stat, pathStat)) {
          throw new Error(`Workspace directory changed during access: ${path.relative(root, directory.target) || '.'}`);
        }
        if (directory.descriptor !== undefined) {
          const opened = fs.fstatSync(directory.descriptor);
          if (!opened.isDirectory() || !sameFilesystemEntry(directory.stat, opened)) {
            throw new Error(`Workspace directory changed during access: ${path.relative(root, directory.target) || '.'}`);
          }
        }
      }
    },
    fsync: () => {
      parent.descriptor === undefined
        ? fsyncDirectory(parent.target)
        : fsyncDescriptor(parent.descriptor);
    },
    close: () => closeGuardedDirectories(directories),
  };
}

function fsyncDescriptor(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error;
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fsyncDescriptor(descriptor);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}

function openDirectoryDescriptor(target: string): number | undefined {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const directoryOnly = typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0;
  try {
    return fs.openSync(target, fs.constants.O_RDONLY | noFollow | directoryOnly);
  } catch (error) {
    if (process.platform === 'win32') return undefined;
    throw error;
  }
}

function descriptorDirectoryPath(descriptor: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const candidate = `/proc/self/fd/${descriptor}`;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function closeGuardedDirectories(directories: GuardedDirectory[]): void {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const directory = directories[index]!;
    if (directory.descriptor === undefined) continue;
    try { fs.closeSync(directory.descriptor); } catch { /* best-effort descriptor cleanup */ }
  }
}

function assertRegularTarget(target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe workspace file: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFilesystemEntry(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}
