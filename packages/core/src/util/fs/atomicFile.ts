/**
 * Durable same-directory atomic file replacement for core persistence (0.4.17).
 *
 * Staging, file fsync, identity reporting, and parent-directory fsync prevent
 * readers from observing partial contents and let callers prove the staged
 * version. Existing targets and staged paths must be regular non-symlink files;
 * exclusive writes never replace a concurrent creator.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicFileWriteOptions {
  mode?: number;
  beforeCommit?: () => void;
  /** Durable identity of the fully-fsynced sibling staged for commit. */
  onStaged?: (staged: AtomicFileStagedVersion) => void;
  /** Commit only when the target is still absent; never replace a raced creator. */
  exclusive?: boolean;
}

export interface AtomicFileStagedVersion {
  temporaryPath: string;
  mode: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Durably replace one regular file without exposing partial contents. The
 * caller owns parent-directory policy; this helper never follows a target
 * symlink and always stages beside the destination before the atomic rename.
 */
export function writeFileAtomic(
  target: string,
  contents: string | Buffer,
  options: AtomicFileWriteOptions = {},
): void {
  const directory = path.dirname(target);
  const existing = lstatIfPresent(target);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Unsafe file target: ${target}`);
  }

  const preserveExactMode = options.mode !== undefined || existing !== undefined;
  const mode = options.mode ?? (existing ? existing.mode & 0o777 : 0o666);
  const nonce = crypto.randomBytes(12).toString('hex');
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${nonce}.tmp`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      mode,
    );
    fs.writeFileSync(descriptor, contents);
    // openSync applies the process umask for a new file. Only override that
    // when the caller supplied an explicit mode or we are preserving the
    // exact mode of an existing destination.
    if (preserveExactMode) fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const stagedStat = fs.lstatSync(temporary);
    if (stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
      throw new Error(`Unsafe staged file: ${temporary}`);
    }
    const stagedVersion: AtomicFileStagedVersion = {
      temporaryPath: temporary,
      mode: stagedStat.mode & 0o777,
      dev: stagedStat.dev,
      ino: stagedStat.ino,
      size: stagedStat.size,
      mtimeMs: stagedStat.mtimeMs,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    };
    options.onStaged?.(stagedVersion);
    options.beforeCommit?.();
    assertStagedFileVersion(temporary, stagedStat, stagedVersion.sha256);
    if (options.exclusive) {
      // A hard link is the portable Node primitive with create-if-absent
      // semantics. Unlike rename, it fails with EEXIST when another writer
      // created the target after our initial check.
      fs.linkSync(temporary, target);
      fs.rmSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort temp cleanup */ }
  }
}

function assertStagedFileVersion(
  temporary: string,
  expected: fs.Stats,
  expectedSha256: string,
): void {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    const beforeOpen = fs.lstatSync(temporary);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || !sameStableFile(expected, beforeOpen)) {
      throw new Error(`Staged file changed before commit: ${temporary}`);
    }
    descriptor = fs.openSync(temporary, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameStableFile(expected, opened)) {
      throw new Error(`Staged file changed before commit: ${temporary}`);
    }
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(temporary);
    if (actualSha256 !== expectedSha256 || !sameStableFile(expected, afterRead) ||
        afterPath.isSymbolicLink() || !afterPath.isFile() || !sameStableFile(expected, afterPath)) {
      throw new Error(`Staged file changed before commit: ${temporary}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Staged file changed before commit: ${temporary}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
  }
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
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
