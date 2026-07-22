/** Public contracts and immutable hard ceilings for repository scanning. */

export interface RepositoryScanLimits {
  /** Directory entries examined, including ignored and unreadable entries. */
  maxEntries: number;
  /** Regular text-file read attempts, including files later classified as binary. */
  maxFiles: number;
  /** Bytes read across text, binary, and truncated files. */
  maxAggregateBytes: number;
  /** Bytes read from any one file. */
  maxFileBytes: number;
  /** Directory nesting below the repository root; root files are depth zero. */
  maxDepth: number;
  /** Wall-clock traversal budget in milliseconds. */
  deadlineMs: number;
}

export interface RepositoryScanOptions {
  /** Optional lower limits; the exported defaults are hard safety maxima. */
  limits?: Partial<RepositoryScanLimits>;
  /** Injectable monotonic-enough clock for deterministic deadline tests. */
  now?: () => number;
}

export interface RepositoryScanFile {
  /** POSIX-style path relative to the repository root. */
  path: string;
  /** File size observed through the opened descriptor. */
  size: number;
  /** UTF-8 content bounded by both per-file and aggregate byte limits. */
  content: string;
  truncated: boolean;
}

export type RepositoryScanStopReason =
  | 'deadline'
  | 'entry-limit'
  | 'file-limit'
  | 'aggregate-byte-limit'
  | 'file-byte-limit'
  | 'depth-limit';

export interface RepositoryScanSummary {
  /** Recognized regular files at the repository root. */
  markers: string[];
  /** Traversable POSIX-style directory paths, including empty directories. */
  directories: string[];
  files: RepositoryScanFile[];
  stats: {
    entriesVisited: number;
    directoriesVisited: number;
    filesRead: number;
    /** Successful bytes plus conservative reservations for failed read attempts. */
    bytesRead: number;
    ignoredEntries: number;
    unreadableEntries: number;
  };
  /** Limits encountered, returned in a stable order. */
  stoppedBy: RepositoryScanStopReason[];
}

export const DEFAULT_REPOSITORY_SCAN_LIMITS: Readonly<RepositoryScanLimits> = Object.freeze({
  maxEntries: 2_000,
  maxFiles: 128,
  maxAggregateBytes: 512 * 1024,
  maxFileBytes: 64 * 1024,
  maxDepth: 8,
  deadlineMs: 900,
});

/** Fixed, case-sensitive root signals prioritized ahead of ordinary files. */
export const REPOSITORY_SCAN_ROOT_MARKERS: readonly string[] = Object.freeze([
  'AGENT.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CMakeLists.txt',
  'Cargo.toml',
  'DESIGN.md',
  'Dockerfile',
  'Gemfile',
  'Makefile',
  'README.md',
  'README.rst',
  'README.txt',
  'build.gradle',
  'build.gradle.kts',
  'compose.yaml',
  'compose.yml',
  'design.md',
  'docker-compose.yaml',
  'docker-compose.yml',
  'dvc.yaml',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
]);
