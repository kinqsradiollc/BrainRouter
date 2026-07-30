import fs from 'node:fs';
import path from 'node:path';

export interface AsarReadGuard {
  archivePath: string;
  archiveStat: fs.Stats;
}

function containingAsarArchive(entryPath: string): string | null {
  let current = path.resolve(entryPath);
  while (true) {
    if (path.basename(current).endsWith('.asar')) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isContainedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readArchiveStat(archivePath: string): fs.Stats {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    return fs.lstatSync(archivePath);
  } finally {
    electronProcess.noAsar = previous;
  }
}

export function containedAsarArchive(
  filePath: string,
  boundaryRoot: string,
  containmentRoot: string,
): string | null {
  const resolvedFile = path.resolve(filePath);
  const resolvedBoundary = path.resolve(boundaryRoot);
  const resolvedContainment = path.resolve(containmentRoot);
  const archivePath = containingAsarArchive(resolvedFile);
  if (
    !archivePath ||
    containingAsarArchive(resolvedBoundary) !== archivePath ||
    containingAsarArchive(resolvedContainment) !== archivePath ||
    !isContainedPath(resolvedFile, resolvedBoundary) ||
    !isContainedPath(resolvedFile, resolvedContainment)
  ) {
    return null;
  }
  return archivePath;
}

export function prepareAsarRead(
  filePath: string,
  boundaryRoot: string,
  containmentRoot: string,
): AsarReadGuard | null {
  const archivePath = containedAsarArchive(filePath, boundaryRoot, containmentRoot);
  if (!archivePath) return null;
  const archiveStat = readArchiveStat(archivePath);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) return null;
  return { archivePath, archiveStat };
}

export function verifyAsarRead(
  guard: AsarReadGuard,
  filePath: string,
  openedStat: fs.Stats,
): boolean {
  const archiveAfter = readArchiveStat(guard.archivePath);
  const pathStat = fs.statSync(filePath);
  return guard.archiveStat.isFile()
    && archiveAfter.isFile()
    && guard.archiveStat.dev === archiveAfter.dev
    && guard.archiveStat.ino === archiveAfter.ino
    && guard.archiveStat.size === archiveAfter.size
    && guard.archiveStat.mtimeMs === archiveAfter.mtimeMs
    && pathStat.isFile()
    && pathStat.size === openedStat.size;
}
