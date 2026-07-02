/**
 * App shell — the background/dashboard task derivations: the live-vs-disk
 * Running list, the per-workspace dashboard boards, cross-workspace running
 * indicators, and the "open a task (switching workspace first if needed)"
 * action. Extracted from App.tsx verbatim; bodies + deps are unchanged.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { workspaceRunCounts, runningWorkspaceSet } from '../lib/workspace/runningIndicators.js';
import { type DashTask, type WorkspaceDash } from '../lib/workspace/dashboard.js';
import type { FleetRow } from '../types.js';
import type { GitState } from '../lib/git/useGitState.js';

interface LiveChild { childId: string; role: string; tool?: string; startedAt: number }

export interface DashboardTasksCtx {
  liveChildren: Record<string, LiveChild>;
  fleet: FleetRow[];
  viewKey: string;
  dashScope: 'workspace' | 'all';
  globalBoards: WorkspaceDash[] | null;
  recentTasks: FleetRow[];
  finishedTasks: Array<{ id: string; label: string; status: string }>;
  activeRoot: string;
  reviewGate: GitState['reviewGate'];
  runningWs: Set<string>;
  hostUp: boolean;
  openTask: (f: FleetRow) => void;
  switchToWorkspace: (root: string) => void;
}

export interface DashboardTasks {
  runningTasks: FleetRow[];
  backgroundTasks: FleetRow[];
  dashBoards: WorkspaceDash[];
  openDashboardTask: (t: DashTask) => void;
  workspaceRunCount: Map<string, number>;
  runningWorkspaces: Set<string>;
}

export function useDashboardTasks(ctx: DashboardTasksCtx): DashboardTasks {
  const {
    liveChildren, fleet, viewKey, dashScope, globalBoards, recentTasks, finishedTasks, activeRoot,
    reviewGate, runningWs, hostUp, openTask, switchToWorkspace,
  } = ctx;
  const pendingDashboardTaskRef = useRef<DashTask | null>(null);

  // DESK-5n — the Running list the panels show: live in-turn children (from
  // child-* events) unioned with the disk-backed fleet (detached /bg workers,
  // workflows). Dedup by id, preferring the disk entry (it carries worktree).
  const runningTasks = useMemo<FleetRow[]>(() => {
    const byId = new Map<string, FleetRow>();
    for (const c of Object.values(liveChildren)) {
      byId.set(c.childId, { kind: 'agent', id: c.childId, label: `${c.role}·${c.childId.slice(-4)}${c.tool ? ` — ${c.tool}` : ''}`, role: c.role, startedAt: new Date(c.startedAt).toISOString(), parentSessionKey: viewKey });
    }
    for (const f of fleet) byId.set(f.id, f); // disk entry wins on collision
    return [...byId.values()];
  }, [liveChildren, fleet, viewKey]);
  // Background work is workspace-scoped UI, not chat-list content. Chat rows stay
  // pure conversations; task/workflow transcripts open from the Background panel.
  const backgroundTasks = runningTasks;
  const dashBoards = useMemo<WorkspaceDash[]>(() => {
    if (dashScope === 'all') return globalBoards ?? [];
    const tasks: DashTask[] = [];
    const seen = new Set<string>();
    const add = (task: DashTask): void => {
      if (!task.id) return;
      const key = `${task.kind}:${task.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      tasks.push({ ...task, workspaceRoot: activeRoot });
    };
    for (const f of backgroundTasks) add({ ...f, workspaceRoot: activeRoot, status: f.status ?? 'running' });
    for (const f of recentTasks) add({ ...f, workspaceRoot: activeRoot });
    for (const t of finishedTasks) add({ kind: 'agent', id: t.id, label: t.label, status: /fail|stale|interrupt/i.test(t.status) ? 'failed' : 'completed', workspaceRoot: activeRoot });
    const activeDisk = globalBoards?.find((b) => b.workspaceRoot === activeRoot);
    for (const t of activeDisk?.tasks ?? []) add({ ...t, workspaceRoot: activeRoot });
    return [{ workspaceRoot: activeRoot, tasks, reviewGate }];
  }, [dashScope, globalBoards, backgroundTasks, recentTasks, finishedTasks, activeRoot, reviewGate]);
  const openDashboardTask = useCallback((t: DashTask): void => {
    if (t.workspaceRoot && t.workspaceRoot !== activeRoot) {
      pendingDashboardTaskRef.current = t;
      switchToWorkspace(t.workspaceRoot);
      return;
    }
    openTask(t as FleetRow);
  }, [activeRoot, openTask, switchToWorkspace]);
  useEffect(() => {
    const pending = pendingDashboardTaskRef.current;
    if (!pending || !hostUp) return;
    if (pending.workspaceRoot && pending.workspaceRoot !== activeRoot) return;
    pendingDashboardTaskRef.current = null;
    const row = backgroundTasks.find((t) => t.id === pending.id) ?? (pending as FleetRow);
    openTask(row);
  }, [activeRoot, backgroundTasks, hostUp, openTask]);
  // Fix 4 / §3 — cross-workspace running indicators. globalBoards (durable +
  // live, polled below) gives the active-task count per NON-active workspace;
  // the active workspace prefers its live fleet. Drives the sidebar dot + count
  // so a background task in workspace A stays visible while viewing workspace B.
  const workspaceRunCount = useMemo<Map<string, number>>(
    () => workspaceRunCounts(globalBoards, activeRoot, runningTasks.length),
    [globalBoards, activeRoot, runningTasks],
  );
  const runningWorkspaces = useMemo<Set<string>>(
    () => runningWorkspaceSet(runningWs, workspaceRunCount),
    [runningWs, workspaceRunCount],
  );

  return { runningTasks, backgroundTasks, dashBoards, openDashboardTask, workspaceRunCount, runningWorkspaces };
}
