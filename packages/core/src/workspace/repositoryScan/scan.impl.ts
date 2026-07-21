/**
 * Bounded, read-only repository scanning for assisted workspace onboarding
 * for assisted setup. The scanner returns only root-relative UTF-8 text, applies
 * every resource limit before further traversal, and never follows project
 * symlinks. Shallow files and fixed root markers are considered first so a
 * useful deterministic summary survives even when a large repository reaches
 * a limit.
 */
import fs from 'node:fs';
import {
  openRepositoryTraversal,
  type RepositoryTraversalDirectory,
  type RepositoryTraversalFile,
} from './traversal.js';
import {
  compareRepositoryDirents,
  compareRepositoryStrings,
  compareRootRepositoryEntries,
  isIgnoredRepositoryDirectory,
  isKnownBinaryRepositoryFile,
  isProbablyBinaryRepositoryBuffer,
  isSensitiveRepositoryFile,
} from './policy.js';
import {
  DEFAULT_REPOSITORY_SCAN_LIMITS,
  REPOSITORY_SCAN_ROOT_MARKERS,
  type RepositoryScanLimits,
  type RepositoryScanOptions,
  type RepositoryScanStopReason,
  type RepositoryScanSummary,
} from './types.js';
import { containsWorkspaceSecretMaterial } from '../workspaceContentSafety.js';

const STOP_REASON_ORDER: readonly RepositoryScanStopReason[] = [
  'deadline',
  'entry-limit',
  'file-limit',
  'aggregate-byte-limit',
  'file-byte-limit',
  'depth-limit',
];

interface PendingDirectory {
  segments: string[];
  depth: number;
  expected: fs.Stats;
}

/**
 * Scan a repository without writing, following symlinks, or returning absolute
 * paths. Unreadable roots and entries produce an empty/partial summary instead
 * of failing onboarding.
 */
export function scanRepository(
  workspaceRoot: string,
  options: RepositoryScanOptions = {},
): RepositoryScanSummary {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const stopReasons = new Set<RepositoryScanStopReason>();
  const summary: RepositoryScanSummary = {
    markers: [],
    directories: [],
    files: [],
    stats: {
      entriesVisited: 0,
      directoriesVisited: 0,
      filesRead: 0,
      bytesRead: 0,
      ignoredEntries: 0,
      unreadableEntries: 0,
    },
    stoppedBy: [],
  };

  let traversal: ReturnType<typeof openRepositoryTraversal>;
  try {
    traversal = openRepositoryTraversal(workspaceRoot);
  } catch {
    summary.stats.unreadableEntries += 1;
    return summary;
  }

  const deadlineReached = (): boolean => {
    if (now() - startedAt < limits.deadlineMs) return false;
    stopReasons.add('deadline');
    return true;
  };
  const resourceLimitReached = (): boolean => {
    if (deadlineReached()) return true;
    if (summary.stats.filesRead >= limits.maxFiles) {
      stopReasons.add('file-limit');
      return true;
    }
    if (summary.stats.bytesRead >= limits.maxAggregateBytes) {
      stopReasons.add('aggregate-byte-limit');
      return true;
    }
    return false;
  };
  const entryLimitReached = (): boolean => {
    if (summary.stats.entriesVisited < limits.maxEntries) return false;
    stopReasons.add('entry-limit');
    return true;
  };

  const directories: PendingDirectory[] = [{ segments: [], depth: 0, expected: traversal.rootStat }];
  let nextDirectory = 0;
  let halt = false;

  const processEntry = (
    directory: RepositoryTraversalDirectory,
    pending: PendingDirectory,
    name: string,
    stat: fs.Stats,
  ): boolean => {
    if (stat.isSymbolicLink()) {
      summary.stats.ignoredEntries += 1;
      return false;
    }

    if (stat.isDirectory()) {
      if (isIgnoredRepositoryDirectory(name)) {
        summary.stats.ignoredEntries += 1;
        return false;
      }
      summary.directories.push(repositoryPath([...pending.segments, name]));
      if (pending.depth >= limits.maxDepth) {
        summary.stats.ignoredEntries += 1;
        stopReasons.add('depth-limit');
        return false;
      }
      directories.push({
        segments: [...pending.segments, name],
        depth: pending.depth + 1,
        expected: stat,
      });
      return false;
    }

    if (!stat.isFile()) {
      summary.stats.ignoredEntries += 1;
      return false;
    }

    if (pending.depth === 0 && REPOSITORY_SCAN_ROOT_MARKERS.includes(name)) summary.markers.push(name);
    if (isSensitiveRepositoryFile(name) || isKnownBinaryRepositoryFile(name)) {
      summary.stats.ignoredEntries += 1;
      return false;
    }

    if (summary.stats.filesRead >= limits.maxFiles) {
      stopReasons.add('file-limit');
      return true;
    }
    const remainingAggregate = limits.maxAggregateBytes - summary.stats.bytesRead;
    if (remainingAggregate <= 0) {
      stopReasons.add('aggregate-byte-limit');
      return true;
    }

    summary.stats.filesRead += 1;
    const relativePath = repositoryPath([...pending.segments, name]);
    const readLimit = Math.min(limits.maxFileBytes, remainingAggregate);
    const reservedBytes = Math.min(stat.size, readLimit);
    const perFileTruncated = stat.size > limits.maxFileBytes;
    const aggregateTruncated = stat.size > remainingAggregate;
    // Reserve before access so a file that changes after the bytes are read
    // cannot evade the aggregate ceiling by failing final inode validation.
    summary.stats.bytesRead += reservedBytes;
    if (perFileTruncated) stopReasons.add('file-byte-limit');
    if (aggregateTruncated) stopReasons.add('aggregate-byte-limit');
    let opened: RepositoryTraversalFile;
    try {
      opened = directory.readRegularFile(name, stat, readLimit);
    } catch {
      summary.stats.unreadableEntries += 1;
      if (summary.stats.bytesRead >= limits.maxAggregateBytes) {
        stopReasons.add('aggregate-byte-limit');
        return true;
      }
      return aggregateTruncated;
    }

    if (isProbablyBinaryRepositoryBuffer(opened.buffer)) {
      summary.stats.ignoredEntries += 1;
      return aggregateTruncated;
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(opened.buffer);
    } catch {
      summary.stats.ignoredEntries += 1;
      return false;
    }
    if (containsWorkspaceSecretMaterial(content, {
      truncated: perFileTruncated || aggregateTruncated,
    })) {
      summary.stats.ignoredEntries += 1;
      return aggregateTruncated;
    }

    summary.files.push({
      path: relativePath,
      size: opened.size,
      content,
      truncated: perFileTruncated || aggregateTruncated,
    });
    return aggregateTruncated;
  };

  try {
    while (nextDirectory < directories.length && !halt) {
      if (resourceLimitReached() || entryLimitReached()) break;
      const pending = directories[nextDirectory++];
      if (!pending) break;

      let directory: RepositoryTraversalDirectory;
      try {
        directory = traversal.openDirectory(pending.segments, pending.expected);
        summary.stats.directoriesVisited += 1;
      } catch {
        summary.stats.unreadableEntries += 1;
        continue;
      }

      let stopAfterDirectory = false;
      const handledRootEntries = new Set<string>();
      try {
        if (pending.depth === 0) {
          for (const marker of REPOSITORY_SCAN_ROOT_MARKERS) {
            if (resourceLimitReached()) {
              halt = true;
              break;
            }
            if (entryLimitReached()) {
              stopAfterDirectory = true;
              break;
            }

            let stat: fs.Stats;
            try {
              stat = directory.lstatEntry(marker);
            } catch (error) {
              if (isMissingEntry(error)) continue;
              summary.stats.entriesVisited += 1;
              summary.stats.unreadableEntries += 1;
              handledRootEntries.add(marker);
              if (entryLimitReached()) stopAfterDirectory = true;
              continue;
            }
            summary.stats.entriesVisited += 1;
            handledRootEntries.add(marker);
            if (processEntry(directory, pending, marker, stat)) {
              halt = true;
              break;
            }
            if (entryLimitReached()) {
              stopAfterDirectory = true;
              break;
            }
          }
        }

        const entries: fs.Dirent[] = [];
        while (!halt && !stopAfterDirectory) {
          if (deadlineReached()) {
            halt = true;
            break;
          }
          if (entryLimitReached()) {
            stopAfterDirectory = true;
            break;
          }

          let entry: fs.Dirent | null;
          try {
            entry = directory.readNext();
          } catch {
            summary.stats.unreadableEntries += 1;
            break;
          }
          if (entry === null) break;
          if (pending.depth === 0 && handledRootEntries.has(entry.name)) continue;

          summary.stats.entriesVisited += 1;
          entries.push(entry);
          if (entryLimitReached()) stopAfterDirectory = true;
        }

        entries.sort(pending.depth === 0 ? compareRootRepositoryEntries : compareRepositoryDirents);
        if (!halt) {
          for (const entry of entries) {
            if (resourceLimitReached()) {
              halt = true;
              break;
            }
            let stat: fs.Stats;
            try {
              stat = directory.lstatEntry(entry.name);
            } catch {
              summary.stats.unreadableEntries += 1;
              continue;
            }
            if (processEntry(directory, pending, entry.name, stat)) {
              halt = true;
              break;
            }
          }
        }
      } finally {
        directory.close();
      }
      if (stopAfterDirectory) halt = true;
    }
  } finally {
    traversal.close();
  }

  summary.markers.sort(compareRepositoryStrings);
  summary.directories.sort(compareRepositoryStrings);
  summary.files.sort((left, right) => compareRepositoryStrings(left.path, right.path));
  summary.stoppedBy = STOP_REASON_ORDER.filter((reason) => stopReasons.has(reason));
  return summary;
}

function resolveLimits(overrides: Partial<RepositoryScanLimits> | undefined): RepositoryScanLimits {
  const limits = { ...DEFAULT_REPOSITORY_SCAN_LIMITS, ...(overrides ?? {}) };
  validateCountLimit('maxEntries', limits.maxEntries, DEFAULT_REPOSITORY_SCAN_LIMITS.maxEntries);
  validateCountLimit('maxFiles', limits.maxFiles, DEFAULT_REPOSITORY_SCAN_LIMITS.maxFiles);
  validateCountLimit(
    'maxAggregateBytes',
    limits.maxAggregateBytes,
    DEFAULT_REPOSITORY_SCAN_LIMITS.maxAggregateBytes,
  );
  validateCountLimit('maxFileBytes', limits.maxFileBytes, DEFAULT_REPOSITORY_SCAN_LIMITS.maxFileBytes);
  validateCountLimit('maxDepth', limits.maxDepth, DEFAULT_REPOSITORY_SCAN_LIMITS.maxDepth);
  if (!Number.isFinite(limits.deadlineMs) || limits.deadlineMs < 0) {
    throw new TypeError('Repository scan deadlineMs must be a finite non-negative number.');
  }
  if (limits.deadlineMs > DEFAULT_REPOSITORY_SCAN_LIMITS.deadlineMs) {
    throw new TypeError(
      `Repository scan deadlineMs must not exceed ${DEFAULT_REPOSITORY_SCAN_LIMITS.deadlineMs}.`,
    );
  }
  return limits;
}

function validateCountLimit(name: keyof RepositoryScanLimits, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Repository scan ${name} must be a non-negative safe integer.`);
  }
  if (value > maximum) {
    throw new TypeError(`Repository scan ${name} must not exceed ${maximum}.`);
  }
}

function repositoryPath(segments: readonly string[]): string {
  return segments.length === 0 ? '.' : segments.join('/');
}

function isMissingEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
