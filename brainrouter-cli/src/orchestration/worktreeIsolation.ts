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

/**
 * Capture a child worktree's changes (so the work isn't silently lost) and then
 * remove the worktree. Without this, isolated children leaked their worktree
 * dirs under `$TMPDIR/brainrouter-worktrees/` forever and `git worktree list`
 * drifted from the filesystem. Returns a capped diff summary for the caller to
 * surface in the child's completion record ("report diff", the merge-back half).
 * Best-effort + never throws — cleanup failure must not break spawn teardown.
 */
export function removeChildWorktree(
  isolation: ChildWorktreeIsolation | null | undefined,
  maxDiffChars = 4000,
): { ok: boolean; diff?: string; changedFiles?: number; notice?: string } {
  if (!isolation || isolation.kind !== 'git-worktree') return { ok: true };
  const { sourceRoot, worktreeRoot } = isolation;
  let diff: string | undefined;
  let changedFiles: number | undefined;
  try {
    if (fs.existsSync(worktreeRoot)) {
      const stat = runGit(worktreeRoot, ['diff', '--stat', 'HEAD']);
      if (stat.ok && stat.stdout.trim()) {
        const lines = stat.stdout.trim().split('\n');
        changedFiles = Math.max(0, lines.length - 1); // last line is the summary
        const full = runGit(worktreeRoot, ['diff', 'HEAD']);
        const body = (full.ok ? full.stdout : stat.stdout).trim();
        diff = body.length > maxDiffChars ? `${body.slice(0, maxDiffChars)}\n… [diff truncated]` : body;
      }
    }
  } catch { /* diff capture is best-effort */ }
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
    notice: removed.ok ? undefined : `git worktree remove reported: ${removed.stderr.trim() || 'non-zero exit'} (force-removed the directory)`,
  };
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
