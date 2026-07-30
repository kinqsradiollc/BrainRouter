/**
 * CONCURRENT-WORKTREE AWARENESS — passive "who else is here" context for the
 * agent. When more than one git worktree exists in a repo, a second agent may be
 * working in one; the agent's Runtime Context lists the OTHER worktrees so it
 * knows to stay in its own and not touch a branch/tree it doesn't own. This is
 * best-effort awareness, never a hard dependency (the destructive-command guard
 * is the actual enforcement).
 */
import path from 'node:path';

import type { WorktreeAwarenessHost } from './awareness/host/contracts.js';
import { nodeWorktreeAwarenessHost } from './awareness/host/nodeWorktreeAwarenessHost.js';

export type { WorktreeAwarenessHost } from './awareness/host/contracts.js';

/**
 * Parse `git worktree list --porcelain` output into `"<path> (<branch>)"` lines,
 * EXCLUDING the caller's own worktree (`selfPath`). Pure + unit-tested.
 */
export function parseWorktreePorcelain(output: string, selfPath: string): string[] {
  const self = path.resolve(selfPath);
  const lines: string[] = [];
  // Porcelain blocks are separated by a blank line; each has a `worktree <path>`
  // and either `branch refs/heads/<name>` or `detached`.
  for (const block of output.split(/\n\s*\n/)) {
    const wt = block.match(/^worktree\s+(.+)$/m);
    if (!wt) continue;
    const wtPath = wt[1].trim();
    if (path.resolve(wtPath) === self) continue; // my own worktree — skip
    const branch = block.match(/^branch\s+refs\/heads\/(.+)$/m);
    const label = branch ? branch[1].trim() : /^detached\b/m.test(block) ? 'detached HEAD' : 'unknown';
    lines.push(`${wtPath} (${label})`);
  }
  return lines;
}

/**
 * Best-effort list of OTHER git worktrees in the repo containing `workspaceRoot`.
 * Returns `[]` when there's only one worktree, when it isn't a git repo, or on any
 * error — passive awareness must never break prompt assembly. Capped + timed out.
 */
export function listOtherWorktrees(
  workspaceRoot: string,
  host: WorktreeAwarenessHost = nodeWorktreeAwarenessHost,
): string[] {
  try {
    const output = host.listPorcelain(workspaceRoot);
    return parseWorktreePorcelain(output, workspaceRoot).slice(0, 12);
  } catch {
    return [];
  }
}
