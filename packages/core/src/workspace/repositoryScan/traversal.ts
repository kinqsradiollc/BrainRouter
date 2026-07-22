/**
 * Descriptor-guarded filesystem traversal for bounded repository scans
 * for assisted setup. Linux child access is rooted at open directory descriptors;
 * portable Node runtimes retain every available ancestor descriptor and
 * revalidate canonical paths around each operation so queued swaps fail closed.
 */
import fs from 'node:fs';
import path from 'node:path';

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const DIRECTORY_ONLY = typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0;

export interface RepositoryTraversalFile {
  buffer: Buffer;
  size: number;
}

export interface RepositoryTraversalDirectory {
  /** Canonical repository-relative POSIX path, or `.` for the root. */
  relativePath: string;
  readNext(): fs.Dirent | null;
  lstatEntry(name: string): fs.Stats;
  readRegularFile(name: string, expected: fs.Stats, maxBytes: number): RepositoryTraversalFile;
  close(): void;
}

export interface RepositoryTraversal {
  canonicalRoot: string;
  rootStat: fs.Stats;
  openDirectory(segments: readonly string[], expected: fs.Stats): RepositoryTraversalDirectory;
  close(): void;
}

interface GuardedDirectory {
  canonicalPath: string;
  stat: fs.Stats;
  descriptor?: number;
  descriptorPath?: string;
}

/**
 * Open one stable repository root capability for the full scan. On Linux,
 * inability to expose its descriptor as a path is an access failure rather
 * than permission to fall back to a raceable canonical child path.
 */
export function openRepositoryTraversal(workspaceRoot: string): RepositoryTraversal {
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const root = openGuardedDirectory(canonicalRoot);
  try {
    if (process.platform === 'linux' && root.descriptorPath === undefined) {
      throw new Error('Repository scan cannot anchor the workspace descriptor.');
    }
  } catch (error) {
    closeDescriptor(root.descriptor);
    throw error;
  }

  let closed = false;
  const assertRootStable = (): void => {
    if (closed) throw new Error('Repository scan root is closed.');
    assertGuardedDirectoryStable(canonicalRoot, root);
  };

  return {
    canonicalRoot,
    rootStat: root.stat,
    openDirectory: (segments, expected) => {
      assertSafeSegments(segments);
      assertRootStable();
      const nested: GuardedDirectory[] = [];
      let canonicalParent = canonicalRoot;
      let accessParent = root.descriptorPath ?? canonicalRoot;
      try {
        for (const segment of segments) {
          assertRootStable();
          assertNestedStable(canonicalRoot, nested);
          const canonicalTarget = path.join(canonicalParent, segment);
          const accessTarget = path.join(accessParent, segment);
          const directory = openGuardedDirectory(accessTarget, canonicalTarget);
          nested.push(directory);
          assertRootStable();
          assertNestedStable(canonicalRoot, nested);
          canonicalParent = canonicalTarget;
          accessParent = directory.descriptorPath ?? canonicalTarget;
        }

        const target = nested.at(-1) ?? root;
        if (!sameFilesystemEntry(target.stat, expected)) {
          throw new Error(`Repository directory changed before traversal: ${repositoryPath(segments)}`);
        }
        const accessTarget = target.descriptorPath ?? target.canonicalPath;
        const directory = fs.opendirSync(accessTarget, { bufferSize: 32 });
        const assertStable = (): void => {
          assertRootStable();
          assertNestedStable(canonicalRoot, nested);
        };
        try {
          assertStable();
        } catch (error) {
          directory.closeSync();
          throw error;
        }

        let directoryClosed = false;
        const close = (): void => {
          if (directoryClosed) return;
          directoryClosed = true;
          try {
            directory.closeSync();
          } catch {
            // Best-effort iterator cleanup must preserve a partial safe scan.
          } finally {
            closeGuardedDirectories(nested);
          }
        };
        return {
          relativePath: repositoryPath(segments),
          readNext: () => {
            assertStable();
            const entry = directory.readSync();
            assertStable();
            return entry;
          },
          lstatEntry: (name) => {
            assertSafeEntryName(name);
            assertStable();
            const stat = fs.lstatSync(path.join(accessTarget, name));
            assertStable();
            return stat;
          },
          readRegularFile: (name, entryStat, maxBytes) => {
            assertSafeEntryName(name);
            assertStable();
            const file = readRegularFile(path.join(accessTarget, name), entryStat, maxBytes);
            assertStable();
            return file;
          },
          close,
        };
      } catch (error) {
        closeGuardedDirectories(nested);
        throw error;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeDescriptor(root.descriptor);
    },
  };
}

function openGuardedDirectory(accessPath: string, canonicalPath = accessPath): GuardedDirectory {
  const beforeOpen = fs.lstatSync(accessPath);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory()) {
    throw new Error(`Unsafe repository directory: ${canonicalPath}`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | NOFOLLOW | DIRECTORY_ONLY);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || !sameFilesystemEntry(beforeOpen, opened)) {
      throw new Error(`Repository directory changed during access: ${canonicalPath}`);
    }
    const descriptorPath = descriptorDirectoryPath(descriptor);
    if (process.platform === 'linux' && descriptorPath === undefined) {
      throw new Error(`Repository directory cannot be descriptor-anchored: ${canonicalPath}`);
    }
    return { canonicalPath, stat: opened, descriptor, descriptorPath };
  } catch (error) {
    if (descriptor !== undefined) closeDescriptor(descriptor);
    if (process.platform === 'win32' && descriptor === undefined) {
      return { canonicalPath, stat: beforeOpen };
    }
    throw error;
  }
}

function readRegularFile(target: string, expected: fs.Stats, maxBytes: number): RepositoryTraversalFile {
  let descriptor: number | undefined;
  try {
    const beforeOpen = fs.lstatSync(target);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() ||
        !sameStableFile(beforeOpen, expected)) {
      throw new Error('Repository scan file changed before read.');
    }
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameStableFile(beforeOpen, opened)) {
      throw new Error('Repository scan file changed before read.');
    }

    const requested = Math.min(opened.size, maxBytes);
    const buffer = Buffer.alloc(requested);
    let offset = 0;
    while (offset < requested) {
      const bytes = fs.readSync(descriptor, buffer, offset, requested - offset, offset);
      if (bytes <= 0) throw new Error('Repository scan file changed during read.');
      offset += bytes;
    }

    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameStableFile(opened, afterRead) || afterPath.isSymbolicLink() ||
        !afterPath.isFile() || !sameFilesystemEntry(opened, afterPath)) {
      throw new Error('Repository scan file changed during read.');
    }
    return { buffer, size: opened.size };
  } finally {
    if (descriptor !== undefined) closeDescriptor(descriptor);
  }
}

function assertGuardedDirectoryStable(root: string, directory: GuardedDirectory): void {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(directory.canonicalPath);
  } catch {
    throw new Error(`Repository directory changed during access: ${relativeDirectory(root, directory.canonicalPath)}`);
  }
  const opened = directory.descriptor === undefined ? undefined : fs.fstatSync(directory.descriptor);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() ||
      !sameFilesystemEntry(directory.stat, pathStat) ||
      (opened !== undefined && (!opened.isDirectory() || !sameFilesystemEntry(directory.stat, opened)))) {
    throw new Error(`Repository directory changed during access: ${relativeDirectory(root, directory.canonicalPath)}`);
  }
}

function assertNestedStable(root: string, directories: readonly GuardedDirectory[]): void {
  for (const directory of directories) assertGuardedDirectoryStable(root, directory);
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

function closeGuardedDirectories(directories: readonly GuardedDirectory[]): void {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    closeDescriptor(directories[index]!.descriptor);
  }
}

function closeDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    fs.closeSync(descriptor);
  } catch {
    // Best-effort descriptor cleanup must preserve the traversal failure.
  }
}

function assertSafeSegments(segments: readonly string[]): void {
  for (const segment of segments) assertSafeEntryName(segment);
}

function assertSafeEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') ||
      name.includes('\\') || name.includes('\0')) {
    throw new Error(`Unsafe repository entry name: ${name}`);
  }
}

function repositoryPath(segments: readonly string[]): string {
  return segments.length === 0 ? '.' : segments.join('/');
}

function relativeDirectory(root: string, target: string): string {
  return path.relative(root, target) || '.';
}

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return sameFilesystemEntry(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
