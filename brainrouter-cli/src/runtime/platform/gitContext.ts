import { execFile } from 'node:child_process';

const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * REVIEW-FIX (0.4.7) — git context for `/review`.
 *
 * The CLI collects the diff itself and injects it into the review prompt, so
 * the model never has to spawn an explorer child *just to read the diff* (the
 * orchestration-collapse foot-gun: a single explorer would swallow the whole
 * workflow). The diff is the ground truth the reviewers work from.
 */

export interface ReviewDiff {
  /** The (possibly truncated) `git diff HEAD` text. */
  diff: string;
  /** True when the raw diff exceeded the cap and was trimmed. */
  truncated: boolean;
  /** True when there is anything to review. */
  hasChanges: boolean;
  /** Every tracked or untracked path represented by `diff`. */
  files: string[];
  /** Collection failure. Callers must not turn this into a clean review. */
  error?: string;
}

/**
 * Pure — cap text to `maxChars`, appending a clear truncation marker. Lets the
 * review prompt stay within a sane token budget on a huge diff (and is the
 * unit-testable core of {@link collectReviewDiff}).
 */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n… [diff truncated at ${maxChars} chars — review the rest in-repo]`, truncated: true };
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

/** Run `git <args>` without discarding stdout on expected exit code 1 (`--no-index`). */
function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      const rawCode = (err as (Error & { code?: number | string }) | null)?.code;
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err ? (typeof rawCode === 'number' ? rawCode : null) : 0,
        ...(err ? { error: err.message } : {}),
      });
    });
  });
}

function nulPaths(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0);
}

function failure(label: string, result: GitResult): string | undefined {
  if (result.code === 0) return undefined;
  const detail = result.stderr.trim() || result.error || `git exited ${result.code ?? 'without a status'}`;
  return `${label}: ${detail}`;
}

/**
 * Collect the complete tracked + untracked working-tree diff. A collection
 * failure is returned explicitly so `/review` cannot mistake "git unavailable"
 * or "output exceeded the buffer" for a clean tree. The optional cap remains for
 * legacy callers and tests; the review front door uses the uncapped default and
 * lets the semantic bundle planner enforce model-sized units.
 */
export async function collectReviewDiff(
  workspaceRoot: string,
  maxChars = Number.POSITIVE_INFINITY,
): Promise<ReviewDiff> {
  const repository = await git(['rev-parse', '--is-inside-work-tree'], workspaceRoot);
  const repositoryFailure = failure('Unable to inspect repository', repository);
  if (repositoryFailure || repository.stdout.trim() !== 'true') {
    return {
      diff: '',
      truncated: false,
      hasChanges: false,
      files: [],
      error: repositoryFailure ?? 'Unable to inspect repository: not inside a Git worktree',
    };
  }

  const head = await git(['rev-parse', '--verify', 'HEAD'], workspaceRoot);
  const hasHead = head.code === 0;
  const trackedDiffCommands = hasHead
    ? [['diff', '--binary', 'HEAD', '--', '.']]
    : [['diff', '--binary', EMPTY_GIT_TREE, '--', '.']];
  const trackedNameCommands = hasHead
    ? [['diff', '--name-only', '-z', 'HEAD', '--', '.']]
    : [['diff', '--name-only', '-z', EMPTY_GIT_TREE, '--', '.']];
  const [trackedDiffs, trackedNames, untrackedNames] = await Promise.all([
    Promise.all(trackedDiffCommands.map((args) => git(args, workspaceRoot))),
    Promise.all(trackedNameCommands.map((args) => git(args, workspaceRoot))),
    git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], workspaceRoot),
  ]);
  const commandFailure = [
    ...trackedDiffs.map((result) => failure('Unable to collect tracked diff', result)),
    ...trackedNames.map((result) => failure('Unable to list tracked changes', result)),
    failure('Unable to list untracked changes', untrackedNames),
  ].find((value): value is string => Boolean(value));
  if (commandFailure) {
    return { diff: '', truncated: false, hasChanges: false, files: [], error: commandFailure };
  }

  const tracked = trackedNames.flatMap((result) => nulPaths(result.stdout));
  const untracked = nulPaths(untrackedNames.stdout);
  const untrackedDiffs: string[] = [];
  for (const file of untracked) {
    const result = await git(['diff', '--binary', '--no-index', '--', '/dev/null', file], workspaceRoot);
    if (result.code !== 0 && result.code !== 1) {
      const detail = result.stderr.trim() || result.error || `git exited ${result.code ?? 'without a status'}`;
      return {
        diff: '',
        truncated: false,
        hasChanges: false,
        files: [],
        error: `Unable to collect untracked diff for ${file}: ${detail}`,
      };
    }
    if (!result.stdout.trim()) {
      return {
        diff: '',
        truncated: false,
        hasChanges: false,
        files: [],
        error: `Unable to collect untracked diff for ${file}: git returned no diff`,
      };
    }
    untrackedDiffs.push(result.stdout);
  }

  const raw = [...trackedDiffs.map((result) => result.stdout), ...untrackedDiffs]
    .filter((value) => value.trim())
    .join('\n');
  const files = [...new Set([...tracked, ...untracked])];
  const hasChanges = raw.trim().length > 0;
  const { text, truncated } = capText(raw, maxChars);
  return { diff: text, truncated, hasChanges, files };
}
