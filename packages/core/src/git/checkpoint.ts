/**
 * PER-TURN GIT CHECKPOINT (§5.3) — capture and restore the FULL working state of
 * a git repository, complementing the existing transcript-only rewind (which
 * resets the conversation but never touches the files on disk).
 *
 * A checkpoint records, into a directory:
 *   - the HEAD commit SHA (the tracked baseline);
 *   - `working.patch` — a binary-safe `git diff HEAD` of all uncommitted tracked
 *     changes that existed at checkpoint time;
 *   - `untracked/` — a verbatim copy of every untracked (non-ignored) file;
 *   - `head.bundle` — a git bundle of HEAD, insurance so the reset target
 *     survives even if a later turn's commits get pruned;
 *   - `metadata.json` — the {@link GitCheckpoint} record.
 *
 * Restore is FAIL-CLOSED: it returns an error rather than half-applying if the
 * target commit can't be made reachable or a step fails. It hard-resets tracked
 * state to the checkpoint commit, cleans untracked files created since (keeping
 * gitignored output like node_modules — `clean -fd`, not `-x`), re-applies the
 * captured working changes, then restores the captured untracked files. The net
 * working tree is exactly what it was when the checkpoint was taken.
 *
 * Pure git/fs over `spawnSync` — no Electron, unit-testable with a temp repo. The
 * "refuse while a turn is running" busy-guard is the CALLER's concern (the
 * desktop rollback action), not this stateless capture/restore core.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitCheckpoint {
  /** Commit SHA HEAD pointed at when the checkpoint was taken. */
  headSha: string;
  /** ISO-8601 capture time. */
  createdAt: string;
  /** Absolute path to the checkpoint directory holding patch / untracked / bundle. */
  dir: string;
  /** True when uncommitted tracked changes were captured to `working.patch`. */
  hasWorkingPatch: boolean;
  /** Relative paths of untracked files copied into the checkpoint. */
  untracked: string[];
}

export interface RestoreResult {
  ok: boolean;
  error?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(repoRoot: string, args: string[]): GitResult {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Whether `repoRoot` is inside a git work tree. */
export function isGitRepo(repoRoot: string): boolean {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

/**
 * Capture the repo's full working state into `dir`. Returns null when `repoRoot`
 * is not a git repo or has no commit yet (nothing to baseline against).
 */
export function createGitCheckpoint(repoRoot: string, dir: string): GitCheckpoint | null {
  if (!isGitRepo(repoRoot)) return null;
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) return null; // unborn branch — no commit to reset back to
  const headSha = head.stdout.trim();
  fs.mkdirSync(dir, { recursive: true });

  // 1. Uncommitted tracked changes (staged + unstaged) vs HEAD, binary-safe.
  const diff = git(repoRoot, ['diff', '--binary', 'HEAD']);
  let hasWorkingPatch = false;
  if (diff.ok && diff.stdout.length > 0) {
    fs.writeFileSync(path.join(dir, 'working.patch'), diff.stdout, 'utf8');
    hasWorkingPatch = true;
  }

  // 2. Untracked (non-ignored) files — copied verbatim under untracked/.
  const untracked: string[] = [];
  const listed = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.ok && listed.stdout) {
    for (const rel of listed.stdout.split('\0').filter(Boolean)) {
      const src = path.join(repoRoot, rel);
      const dst = path.join(dir, 'untracked', rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        untracked.push(rel);
      } catch {
        /* file vanished mid-capture — skip it */
      }
    }
  }

  // 3. Bundle HEAD as insurance against later pruning of the reset target.
  git(repoRoot, ['bundle', 'create', path.join(dir, 'head.bundle'), 'HEAD']);

  const checkpoint: GitCheckpoint = {
    headSha,
    createdAt: new Date().toISOString(),
    dir,
    hasWorkingPatch,
    untracked,
  };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(checkpoint, null, 2), 'utf8');
  return checkpoint;
}

/**
 * Restore the repo to a checkpoint's working state. Fail-closed: returns
 * `{ ok:false, error }` without half-applying when the target is unreachable or
 * a git step fails.
 */
export function restoreGitCheckpoint(repoRoot: string, checkpoint: GitCheckpoint): RestoreResult {
  if (!isGitRepo(repoRoot)) return { ok: false, error: 'not a git repository' };
  if (!checkpoint?.headSha) return { ok: false, error: 'checkpoint is missing a headSha' };

  // Ensure the target commit is reachable; otherwise pull it back from the bundle.
  const reachable = () => git(repoRoot, ['cat-file', '-e', `${checkpoint.headSha}^{commit}`]).ok;
  if (!reachable()) {
    const bundle = path.join(checkpoint.dir, 'head.bundle');
    if (fs.existsSync(bundle)) git(repoRoot, ['fetch', bundle, checkpoint.headSha]);
    if (!reachable()) {
      return { ok: false, error: `checkpoint commit ${checkpoint.headSha.slice(0, 8)} is unreachable and not in the bundle` };
    }
  }

  // 1. Hard-reset tracked state to the checkpoint commit.
  const reset = git(repoRoot, ['reset', '--hard', checkpoint.headSha]);
  if (!reset.ok) return { ok: false, error: `git reset failed: ${reset.stderr.trim()}` };

  // 2. Remove untracked files created since (keep gitignored output — no -x).
  git(repoRoot, ['clean', '-fd']);

  // 3. Re-apply the checkpoint's uncommitted tracked changes.
  if (checkpoint.hasWorkingPatch) {
    const patch = path.join(checkpoint.dir, 'working.patch');
    if (fs.existsSync(patch)) {
      const apply = git(repoRoot, ['apply', '--whitespace=nowarn', patch]);
      if (!apply.ok) return { ok: false, error: `re-applying working changes failed: ${apply.stderr.trim()}` };
    }
  }

  // 4. Restore the checkpoint's untracked files.
  for (const rel of checkpoint.untracked) {
    const src = path.join(checkpoint.dir, 'untracked', rel);
    const dst = path.join(repoRoot, rel);
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    } catch {
      /* best-effort restore of one file must not abort the rest */
    }
  }

  return { ok: true };
}
