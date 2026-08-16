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

/**
 * ADR-042 D2/D3 — structured worktree inventory. `parseWorktreePorcelain`
 * (above) yields display strings for the prompt line; the agent-facing
 * `worktree_list`/`worktree_enter` tools need the fields as data.
 */
export interface WorktreeInfo {
  /** Absolute path git reports for the worktree. */
  path: string;
  /** Branch name (no `refs/heads/`), or null when detached / bare. */
  branch: string | null;
  /** HEAD sha, when git reports one. */
  head: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  /** Directory is gone (moved/deleted without `git worktree remove`). */
  prunable: boolean;
  prunableReason?: string;
  /** True for the block whose path === the queried root (the primary). */
  isSelf: boolean;
  /** Best-effort uncommitted-tracked-changes flag (host-computed). */
  dirty?: boolean;
}

/**
 * Parse `git worktree list --porcelain` into structured entries, INCLUDING the
 * queried root (flagged `isSelf`) — unlike `parseWorktreePorcelain`, which drops
 * it. Pure; the derivation rule (D2) is "membership in this list", nothing else.
 */
export function parseWorktreePorcelainStructured(output: string, selfPath: string): WorktreeInfo[] {
  const self = path.resolve(selfPath);
  const out: WorktreeInfo[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    const wt = block.match(/^worktree\s+(.+)$/m);
    if (!wt) continue;
    const wtPath = wt[1].trim();
    const branchMatch = block.match(/^branch\s+refs\/heads\/(.+)$/m);
    const headMatch = block.match(/^HEAD\s+([0-9a-f]+)$/m);
    const lockedMatch = block.match(/^locked(?:\s+(.*))?$/m);
    const prunableMatch = block.match(/^prunable(?:\s+(.*))?$/m);
    out.push({
      path: wtPath,
      branch: branchMatch ? branchMatch[1].trim() : null,
      head: headMatch ? headMatch[1] : null,
      detached: /^detached\b/m.test(block),
      bare: /^bare\b/m.test(block),
      locked: !!lockedMatch,
      lockedReason: lockedMatch?.[1]?.trim() || undefined,
      prunable: !!prunableMatch,
      prunableReason: prunableMatch?.[1]?.trim() || undefined,
      isSelf: path.resolve(wtPath) === self,
    });
  }
  return out;
}

/**
 * The structured inventory of every worktree of the repo containing
 * `workspaceRoot` (including the root itself), capped and best-effort. Returns
 * `[]` when it isn't a git repo or on any error — awareness must not throw.
 * When `withDirty` is set, fills the best-effort `dirty` flag per non-prunable
 * entry via the host.
 */
export function listWorktreesStructured(
  workspaceRoot: string,
  host: WorktreeAwarenessHost = nodeWorktreeAwarenessHost,
  opts: { withDirty?: boolean } = {},
): WorktreeInfo[] {
  let entries: WorktreeInfo[];
  try {
    entries = parseWorktreePorcelainStructured(host.listPorcelain(workspaceRoot), workspaceRoot).slice(0, 24);
  } catch {
    return [];
  }
  if (opts.withDirty && typeof host.isDirty === 'function') {
    for (const e of entries) {
      if (!e.prunable && !e.bare) {
        try { e.dirty = host.isDirty(e.path); } catch { /* best-effort */ }
      }
    }
  }
  return entries;
}

export type AttachableResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; reason: string };

/**
 * D2 derivation rule as a decision: is `target` (a worktree path OR a branch
 * name) an attachable worktree of this repo? Attachable iff git lists it, it is
 * not the current root, and its directory still exists (not prunable / not
 * bare). Every refusal carries the reason and the fix.
 */
export function resolveAttachableWorktree(
  workspaceRoot: string,
  target: string,
  host: WorktreeAwarenessHost = nodeWorktreeAwarenessHost,
): AttachableResult {
  const raw = String(target ?? '').trim();
  if (!raw) return { ok: false, reason: 'A worktree path or branch name is required. Run worktree_list to see the attachable worktrees.' };
  const list = listWorktreesStructured(workspaceRoot, host);
  if (list.length === 0) return { ok: false, reason: 'No git worktrees are visible from this workspace (not a git repository, or git is unavailable).' };
  const asPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
  const match =
    list.find((w) => path.resolve(w.path) === asPath) ??
    list.find((w) => w.branch === raw);
  if (!match) {
    return { ok: false, reason: `No git worktree of this repository matches "${target}". Run worktree_list to see attachable worktrees — only same-repository worktrees can be entered.` };
  }
  if (match.isSelf) return { ok: false, reason: `"${target}" is the current workspace root — it is already active.` };
  if (match.bare) return { ok: false, reason: `"${target}" is the bare repository, not a checkout — there are no files to enter.` };
  if (match.prunable) {
    return { ok: false, reason: `The worktree at ${match.path} is prunable${match.prunableReason ? ` (${match.prunableReason})` : ''} — its directory is gone. Run \`git worktree prune\` or restore it, then try again.` };
  }
  return { ok: true, info: match };
}
