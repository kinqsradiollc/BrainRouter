import { execFile } from 'node:child_process';

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

/** Run `git <args>` in `cwd`, resolving stdout ('' on any error — git absent, not a repo, etc.). */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? ''));
    });
  });
}

/**
 * Collect `git diff HEAD` (staged + unstaged tracked changes) for the workspace,
 * capped to `maxChars`. Never throws — a missing repo / git binary yields an
 * empty, no-changes result so `/review` can fall back gracefully.
 */
export async function collectReviewDiff(workspaceRoot: string, maxChars = 16_000): Promise<ReviewDiff> {
  const raw = await git(['diff', 'HEAD'], workspaceRoot);
  const hasChanges = raw.trim().length > 0;
  const { text, truncated } = capText(raw, maxChars);
  return { diff: text, truncated, hasChanges };
}
