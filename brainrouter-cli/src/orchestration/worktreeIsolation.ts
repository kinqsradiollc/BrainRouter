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
