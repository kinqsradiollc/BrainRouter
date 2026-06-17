/**
 * Pure helpers for the workflow/background dashboard (T1): tab filtering and the
 * cross-workspace merge. Kept pure + node-testable. A "task" is any fleet entry
 * (sub-agent / worker / workflow / bash) plus finished ones.
 */
export interface DashTask {
  kind: string;
  id: string;
  label: string;
  status?: string;
  workspaceRoot?: string;
  startedAt?: string;
  role?: string;
  worktree?: boolean;
  parentSessionKey?: string | null;
}

export type DashTab = 'running' | 'finished' | 'failed' | 'workflows' | 'agents' | 'bash';
export const DASH_TABS: DashTab[] = ['running', 'finished', 'failed', 'workflows', 'agents', 'bash'];

const FAIL = /fail|error|cancel/i;
const DONE = /complete|done|finished|success|ok\b/i;

/** Does a task belong under a given tab? Lifecycle tabs key off status; the rest
 *  key off kind so a finished workflow still appears under "Workflows". */
export function taskMatchesTab(t: DashTask, tab: DashTab): boolean {
  const k = (t.kind || '').toLowerCase();
  const s = (t.status || '').toLowerCase();
  switch (tab) {
    case 'running': return !DONE.test(s) && !FAIL.test(s);
    case 'finished': return DONE.test(s);
    case 'failed': return FAIL.test(s);
    case 'workflows': return k.includes('workflow');
    case 'agents': return /agent|sub|verifier|child|worker/.test(k);
    case 'bash': return /bash|command|shell|run_command|exec/.test(k);
    default: return true;
  }
}

export function filterTasks(tasks: DashTask[], tab: DashTab): DashTask[] {
  return tasks.filter((t) => taskMatchesTab(t, tab));
}

export function countByTab(tasks: DashTask[]): Record<DashTab, number> {
  const out = {} as Record<DashTab, number>;
  for (const tab of DASH_TABS) out[tab] = tasks.filter((t) => taskMatchesTab(t, tab)).length;
  return out;
}

export interface WorkspaceDash {
  workspaceRoot: string;
  tasks: DashTask[];
  reviewGate?: { status: string; blocked: boolean; reason: string } | null;
}

/**
 * Merge per-workspace disk reads (all known workspaces) with a live overlay
 * (the workspaces that currently have an open host). The live entry wins for a
 * workspace; every task is stamped with its OWN workspaceRoot so one workspace's
 * tasks can never be attributed to another. Sorted by root for a stable list.
 */
export function mergeWorkspaceDashboards(disk: WorkspaceDash[], live: Record<string, WorkspaceDash>): WorkspaceDash[] {
  const byRoot = new Map<string, WorkspaceDash>();
  const stamp = (d: WorkspaceDash, root: string): WorkspaceDash => ({ ...d, workspaceRoot: root, tasks: (d.tasks ?? []).map((t) => ({ ...t, workspaceRoot: root })) });
  for (const d of disk) byRoot.set(d.workspaceRoot, stamp(d, d.workspaceRoot));
  for (const [root, l] of Object.entries(live)) byRoot.set(root, stamp(l, root));
  return [...byRoot.values()].sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot));
}

/** Flatten a workspace-dashboard list to a single task list (for the global tab counts). */
export function allTasks(boards: WorkspaceDash[]): DashTask[] {
  return boards.flatMap((b) => b.tasks);
}
