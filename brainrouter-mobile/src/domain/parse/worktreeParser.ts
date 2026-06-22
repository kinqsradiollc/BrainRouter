/**
 * T13 — parse `git worktree list --porcelain` into structured entries. The
 * porcelain stream is blocks of `key value` lines separated by blank lines:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/main
 *   <blank>
 *   worktree /abs/feature
 *   HEAD <sha>
 *   detached
 *
 * The first block is always the main worktree. `branch` is absent when the
 * worktree is detached; `bare` marks a bare repo's main entry. Pure +
 * unit-tested so the panel can rely on it without the host.
 */
export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Short branch name (refs/heads/ stripped), or undefined when detached/bare. */
  branch?: string;
  isDetached: boolean;
  isBare: boolean;
  /** The repository's primary worktree (first block). */
  isMain: boolean;
  /** True when this worktree's path is the one currently open. */
  isCurrent: boolean;
}

export function parseWorktreeList(porcelain: string, currentPath?: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  const flush = (): void => {
    if (cur && cur.path) {
      entries.push({
        path: cur.path,
        head: cur.head,
        branch: cur.branch,
        isDetached: !!cur.isDetached,
        isBare: !!cur.isBare,
        isMain: entries.length === 0,
        isCurrent: false,
      });
    }
    cur = null;
  };
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') { flush(); continue; }
    if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice('worktree '.length).trim() }; continue; }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.isDetached = true;
    else if (line === 'bare') cur.isBare = true;
  }
  flush();
  if (currentPath) {
    const norm = (p: string): string => p.replace(/\/+$/, '');
    for (const e of entries) e.isCurrent = norm(e.path) === norm(currentPath);
  }
  return entries;
}

/** A safe worktree directory name: letters, digits, dash, underscore, dot. */
export function isValidWorktreeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}
