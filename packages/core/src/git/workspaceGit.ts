import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Git/workspace identity for an EXPLICITLY selected workspace folder.
 *
 * The desktop picks a folder directly (folder picker), so — unlike the CLI's
 * cwd-marker discovery in `workspace.ts` — we must NOT promote to a monorepo
 * parent. Workspace operations stay scoped to the selected folder; git
 * operations use the correct OWNING repo and a repo-relative path filter when
 * the workspace is a subdirectory. Shared by CLI + desktop (no desktop-only
 * duplicate git logic).
 */
export interface WorkspaceGitInfo {
  /** realpath of the selected workspace folder. */
  workspaceRoot: string;
  /** Nearest OWNING git toplevel (closest `.git` ancestor), or null if not in a repo. */
  gitRoot: string | null;
  hasGit: boolean;
  /** The workspace folder IS the repo root. */
  isRepoRoot: boolean;
  /** The workspace folder is strictly INSIDE the repo (a subdirectory). */
  isSubdir: boolean;
  /** Display name: basename(gitRoot) when in a repo, else basename(workspaceRoot). */
  repoName: string;
  /** POSIX path from gitRoot → workspaceRoot ('' at the repo root / no git). */
  repoRelativePath: string;
}

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Nearest owning git toplevel for `dir`, via `git rev-parse --show-toplevel`.
 * This honours git's own resolution rules, which is exactly what we want:
 *   - a nested clone with its own `.git` resolves to ITSELF (not the parent),
 *   - a monorepo subdirectory resolves to the OWNING repo root,
 *   - a folder outside any repo → null.
 */
export function findGitRoot(dir: string): string | null {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? '').trim();
  return root ? realpath(root) : null;
}

/** Resolve how a selected workspace folder relates to its owning git repo. */
export function resolveWorkspaceGit(selectedRoot: string): WorkspaceGitInfo {
  const workspaceRoot = realpath(selectedRoot);
  const gitRoot = findGitRoot(workspaceRoot);
  if (!gitRoot) {
    return {
      workspaceRoot, gitRoot: null, hasGit: false, isRepoRoot: false, isSubdir: false,
      repoName: path.basename(workspaceRoot), repoRelativePath: '',
    };
  }
  const isRepoRoot = gitRoot === workspaceRoot;
  const rel = path.relative(gitRoot, workspaceRoot);
  const isSubdir = !isRepoRoot && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return {
    workspaceRoot, gitRoot, hasGit: true, isRepoRoot, isSubdir,
    repoName: path.basename(gitRoot),
    repoRelativePath: isSubdir ? rel.split(path.sep).join('/') : '',
  };
}

/**
 * How to scope a git command to a workspace: run at the git root, but for a
 * subdirectory restrict to its repo-relative pathspec so monorepo-subfolder
 * actions (diff/review/status) don't pull in unrelated parent-repo changes.
 * Repo-root / no-git workspaces get no pathspec restriction.
 */
export function workspaceGitScope(info: WorkspaceGitInfo): { cwd: string; pathspec: string[] } {
  if (!info.gitRoot) return { cwd: info.workspaceRoot, pathspec: [] };
  return { cwd: info.gitRoot, pathspec: info.isSubdir ? [info.repoRelativePath] : [] };
}
