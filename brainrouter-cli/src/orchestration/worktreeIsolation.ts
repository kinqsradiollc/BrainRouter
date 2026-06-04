import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AccessMode } from './roles.js';

export type ChildWorkspaceIsolationMode = 'off' | 'auto' | 'git-worktree';

export interface ChildWorkspaceResolution {
  workspaceRoot: string;
  launchCwd: string;
  isolated: boolean;
  isolation?: {
    kind: 'git-worktree';
    sourceRoot: string;
    worktreeRoot: string;
  };
  notice?: string;
}

interface PrepareChildWorkspaceInput {
  parentWorkspaceRoot: string;
  parentLaunchCwd: string;
  childId: string;
  access: AccessMode;
  mode: ChildWorkspaceIsolationMode;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function gitRoot(workspaceRoot: string): string | null {
  const result = runGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  if (!root) return null;
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'child';
}

function defaultWorktreePath(repoRoot: string, childId: string): string {
  const repoName = safeName(path.basename(repoRoot));
  return path.join(os.tmpdir(), 'brainrouter-worktrees', repoName, safeName(childId));
}

function launchCwdInWorktree(repoRoot: string, parentLaunchCwd: string, worktreeRoot: string): string {
  let realLaunch = parentLaunchCwd;
  try {
    realLaunch = fs.realpathSync(parentLaunchCwd);
  } catch {
    realLaunch = path.resolve(parentLaunchCwd);
  }
  const rel = path.relative(repoRoot, realLaunch);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return worktreeRoot;
  const candidate = path.join(worktreeRoot, rel);
  return fs.existsSync(candidate) ? candidate : worktreeRoot;
}

export function prepareChildWorkspace(input: PrepareChildWorkspaceInput): ChildWorkspaceResolution {
  const parentWorkspaceRoot = fs.realpathSync(input.parentWorkspaceRoot);
  const parentLaunchCwd = (() => {
    try {
      const real = fs.realpathSync(input.parentLaunchCwd);
      return isInside(parentWorkspaceRoot, real) ? real : parentWorkspaceRoot;
    } catch {
      return parentWorkspaceRoot;
    }
  })();

  if (input.access === 'read' || input.mode === 'off') {
    return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false };
  }

  const repoRoot = gitRoot(parentWorkspaceRoot);
  if (!repoRoot || !isInside(repoRoot, parentWorkspaceRoot)) {
    const notice = 'Child workspace isolation requested, but the parent workspace is not inside a git repository.';
    if (input.mode === 'git-worktree') throw new Error(notice);
    return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false, notice };
  }

  const worktreeRoot = defaultWorktreePath(repoRoot, input.childId);
  if (!fs.existsSync(worktreeRoot)) {
    fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
    const created = runGit(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD']);
    if (!created.ok) {
      const reason = created.stderr.trim() || created.stdout.trim() || 'unknown git worktree error';
      const notice = `Child workspace isolation requested, but git worktree creation failed: ${reason}`;
      if (input.mode === 'git-worktree') throw new Error(notice);
      return { workspaceRoot: parentWorkspaceRoot, launchCwd: parentLaunchCwd, isolated: false, notice };
    }
  }

  const realWorktreeRoot = fs.realpathSync(worktreeRoot);
  return {
    workspaceRoot: realWorktreeRoot,
    launchCwd: launchCwdInWorktree(repoRoot, parentLaunchCwd, realWorktreeRoot),
    isolated: true,
    isolation: {
      kind: 'git-worktree',
      sourceRoot: repoRoot,
      worktreeRoot: realWorktreeRoot,
    },
  };
}

export interface ChildWorktreeIsolation {
  kind: 'git-worktree';
  sourceRoot: string;
  worktreeRoot: string;
}

export interface RemoveChildWorktreeOptions {
  /**
   * Cap on the human-readable preview diff. The FULL recovery patch written to
   * `patchFile` is never capped, so no work is lost to truncation. Default 4000.
   */
  maxDiffChars?: number;
  /**
   * CODEX-WORKTREE-MERGEBACK — when true, the child's changes are git-applied
   * back onto the parent working tree (used on a child's CLEAN completion). The
   * apply is gated by `git apply --check` first, so a patch that doesn't apply
   * cleanly leaves the parent tree untouched (no conflict markers) — the work is
   * still recoverable from `patchFile`. Defaults to false (capture-only).
   */
  applyBack?: boolean;
  /**
   * Absolute path to persist the full (uncapped, binary-safe) recovery patch.
   * Lets the parent re-apply the child's work with `git apply <patchFile>` even
   * after the throwaway worktree is gone. Required for `applyBack` to do anything.
   */
  patchFile?: string;
}

export interface RemoveChildWorktreeResult {
  ok: boolean;
  /** Capped, human-readable preview of the child's changes. */
  diff?: string;
  /** Number of files the child changed in its worktree. */
  changedFiles?: number;
  /** Where the full recovery patch was written (iff there were changes + a writable `patchFile`). */
  patchPath?: string;
  /** True when `applyBack` was requested and the patch cleanly applied to the parent tree. */
  applied?: boolean;
  /** Why an `applyBack` attempt was skipped/failed — the patch is still at `patchPath` for manual `git apply`. */
  applyError?: string;
  /** Worktree-removal notice (force-removal fallback). */
  notice?: string;
}

/**
 * Capture a child worktree's changes, optionally merge them back onto the parent
 * tree, then remove the worktree. This is BOTH halves of the isolation contract:
 *
 *  - capture — stage everything (incl. untracked + deletions; `.gitignore` still
 *    excludes build artifacts) and record a capped preview, a changed-file count,
 *    and a FULL binary-safe recovery patch persisted to `patchFile`. Nothing is
 *    silently lost — the complete patch survives the worktree's removal.
 *  - merge-back — when `applyBack` is set (the child finished cleanly), the
 *    persisted patch is `git apply --check`'d and, only if it applies cleanly,
 *    applied onto the parent working tree. A drifted/conflicting patch is left
 *    on disk for a manual apply rather than smearing conflict markers into the
 *    user's tree.
 *
 * Without the removal half, isolated children leaked worktree dirs under
 * `$TMPDIR/brainrouter-worktrees/` forever and `git worktree list` drifted from
 * the filesystem. Best-effort + never throws — cleanup must not break teardown.
 */
export function removeChildWorktree(
  isolation: ChildWorktreeIsolation | null | undefined,
  opts: RemoveChildWorktreeOptions = {},
): RemoveChildWorktreeResult {
  if (!isolation || isolation.kind !== 'git-worktree') return { ok: true };
  const maxDiffChars = opts.maxDiffChars ?? 4000;
  const { sourceRoot, worktreeRoot } = isolation;
  let diff: string | undefined;
  let changedFiles: number | undefined;
  let patchPath: string | undefined;
  let applied: boolean | undefined;
  let applyError: string | undefined;

  try {
    if (fs.existsSync(worktreeRoot)) {
      // Stage everything (tracked edits, new files, deletions) so the patch is
      // COMPLETE. `.gitignore` is still honored, so node_modules/build output
      // stays out — the patch only carries real source changes.
      runGit(worktreeRoot, ['add', '-A']);
      const stat = runGit(worktreeRoot, ['diff', '--cached', '--stat', 'HEAD']);
      if (stat.ok && stat.stdout.trim()) {
        const lines = stat.stdout.trim().split('\n');
        changedFiles = Math.max(0, lines.length - 1); // last line is the summary

        // Full, binary-safe patch — used for both persistence and apply. Never capped.
        const fullRes = runGit(worktreeRoot, ['diff', '--cached', '--binary', 'HEAD']);
        const fullPatch = fullRes.ok ? fullRes.stdout : '';
        if (fullPatch.trim() && opts.patchFile) {
          try {
            fs.mkdirSync(path.dirname(opts.patchFile), { recursive: true });
            fs.writeFileSync(opts.patchFile, fullPatch, 'utf8');
            patchPath = opts.patchFile;
          } catch { /* persistence is best-effort */ }
        }

        // Human preview: plain text diff, capped (pointing at the full patch).
        const previewRes = runGit(worktreeRoot, ['diff', '--cached', 'HEAD']);
        const body = (previewRes.ok ? previewRes.stdout : stat.stdout).trim();
        diff = body.length > maxDiffChars
          ? `${body.slice(0, maxDiffChars)}\n… [diff truncated${patchPath ? ` — full patch at ${patchPath}` : ''}]`
          : body;

        // Merge-back: apply the child's work onto the parent tree on clean exit.
        // Check first so a non-applying patch never mutates the parent tree.
        if (opts.applyBack && patchPath) {
          const check = runGit(sourceRoot, ['apply', '--check', '--whitespace=nowarn', patchPath]);
          if (check.ok) {
            const applyRes = runGit(sourceRoot, ['apply', '--whitespace=nowarn', patchPath]);
            applied = applyRes.ok;
            if (!applyRes.ok) applyError = applyRes.stderr.trim() || 'git apply failed';
          } else {
            applied = false;
            applyError = check.stderr.trim() || 'patch does not apply cleanly to the parent tree';
          }
        }
      }
    }
  } catch { /* capture/apply is best-effort — never block teardown */ }

  // Remove the worktree, then prune the admin entry so `git worktree list` stays honest.
  const removed = runGit(sourceRoot, ['worktree', 'remove', '--force', worktreeRoot]);
  if (!removed.ok) {
    try { if (fs.existsSync(worktreeRoot)) fs.rmSync(worktreeRoot, { recursive: true, force: true }); } catch { /* noop */ }
  }
  runGit(sourceRoot, ['worktree', 'prune']);
  return {
    ok: true,
    diff,
    changedFiles,
    patchPath,
    applied,
    applyError,
    notice: removed.ok ? undefined : `git worktree remove reported: ${removed.stderr.trim() || 'non-zero exit'} (force-removed the directory)`,
  };
}

/**
 * CODEX-WORKTREE-MERGEBACK (A2) — manually apply a persisted recovery patch onto
 * a tree (backs `/agents diff <id> apply`). Gated by `git apply --check` first so
 * a non-applying patch never mutates the tree (no smeared conflict markers).
 * Returns `ok` + a human reason on failure; never throws.
 */
export function applyPatchFile(cwd: string, patchFile: string): { ok: boolean; error?: string } {
  try {
    if (!fs.existsSync(patchFile)) return { ok: false, error: 'patch file not found' };
    const check = runGit(cwd, ['apply', '--check', '--whitespace=nowarn', patchFile]);
    if (!check.ok) return { ok: false, error: check.stderr.trim() || 'patch does not apply cleanly' };
    const applied = runGit(cwd, ['apply', '--whitespace=nowarn', patchFile]);
    return applied.ok ? { ok: true } : { ok: false, error: applied.stderr.trim() || 'git apply failed' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'git apply threw' };
  }
}

/**
 * Startup reconcile: prune git's stale worktree admin entries and delete any
 * leftover `brainrouter-worktrees/<repo>/*` dirs that git no longer tracks
 * (orphans from a crashed prior process). Best-effort; returns how many dirs it
 * removed. Mirrors `reconcileStale` for session records.
 */
export function reconcileOrphanWorktrees(workspaceRoot: string): number {
  let removed = 0;
  try {
    const repoRoot = gitRoot(workspaceRoot);
    if (!repoRoot) return 0;
    runGit(repoRoot, ['worktree', 'prune']);
    const base = path.join(os.tmpdir(), 'brainrouter-worktrees', safeName(path.basename(repoRoot)));
    if (!fs.existsSync(base)) return 0;
    const tracked = new Set(
      (runGit(repoRoot, ['worktree', 'list', '--porcelain']).stdout.match(/^worktree (.+)$/gm) ?? [])
        .map((l) => l.replace(/^worktree /, '').trim()),
    );
    for (const entry of fs.readdirSync(base)) {
      const dir = path.join(base, entry);
      let real = dir;
      try { real = fs.realpathSync(dir); } catch { /* use dir */ }
      if (!tracked.has(real) && !tracked.has(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch { /* noop */ }
      }
    }
  } catch { /* best-effort */ }
  return removed;
}
