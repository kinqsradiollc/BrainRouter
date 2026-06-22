/**
 * BG-TASKS-PANEL (0.4.5) — aggregate the workspace's *currently running*
 * background actors (child agents, worker threads, durable workflows) into one
 * list, so the chat REPL can show a live panel of "what's running in the
 * background right now".
 *
 * The store reads live in `collectRunningTasks` (filesystem-backed state); the
 * `formatBackgroundTasks` renderer is pure so it's unit-testable without IO.
 *
 * Note on placement: this surfaces as a fixed panel above the composer rather
 * than a true side rail — the REPL renders into the terminal's native
 * scrollback (no alternate-screen buffer), so a right rail would scroll away
 * with history. A persistent side rail is part of the 0.5.0 fullscreen TUI.
 */
import { listWorkers } from '../worker/workerStore.js';
import { listSessions } from '../orchestration/orchestrator.js';
import { listRuns, summarizePhases, formatActivePhase } from '../workflow/workflowRun.js';
import { currentPhase, listBackgroundTasks } from './backgroundTaskStore.js';
import { listBackgroundShells, type BgShellRun } from '../exec/backgroundShell.js';
import type { BackgroundTaskRecord } from '@kinqs/brainrouter-types';

export type BackgroundTaskKind = 'agent' | 'worker' | 'workflow' | 'shell';

export interface BackgroundTask {
  kind: BackgroundTaskKind;
  id: string;
  label: string;
  /** ISO start time, when known — lets the panel show elapsed time. */
  startedAt?: string;
  /** Sub-agent role (explorer / reviewer / worker / …) — agents only. */
  role?: string;
  /** True when the actor runs in an isolated git worktree (agents only). */
  worktree?: boolean;
}

export interface DashboardBackgroundTask {
  kind: string;
  id: string;
  label: string;
  status?: string;
  phase?: string;
  durable?: boolean;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
  role?: string;
  worktree?: boolean;
  parentSessionKey?: string | null;
  transcript?: { kind: string; id: string; parentSessionKey?: string };
  requirementId?: string;
  planId?: string;
}

function workflowLabel(r: ReturnType<typeof listRuns>[number]): string {
  if (r.phases && r.phases.length > 0) {
    const active = formatActivePhase(r);
    if (active) return `${r.slug} · ${active}`;
    const { done, total } = summarizePhases(r);
    return `${r.slug} · phase ${done}/${total}`;
  }
  return r.slug;
}

/** WS2 — map an agent-launched background shell (`run_command({background:true})`
 *  — dev servers, long test runs) into a fleet task. Returns null unless it is
 *  currently running. Pure, so it's unit-testable without spawning a process. */
export function shellRunToTask(sh: BgShellRun): BackgroundTask | null {
  if (sh.status !== 'running') return null;
  return { kind: 'shell', id: sh.id, label: sh.command, startedAt: new Date(sh.startedAt).toISOString() };
}

/** Read the live state stores and return everything currently running. */
export function collectRunningTasks(workspaceRoot: string): BackgroundTask[] {
  const tasks: BackgroundTask[] = [];
  try {
    for (const s of listSessions(workspaceRoot)) {
      if (s.status === 'running' || s.status === 'pending') {
        tasks.push({
          kind: 'agent',
          id: s.id,
          label: s.label ? `${s.label} (${s.id})` : s.id,
          startedAt: s.startedAt,
          role: s.role,
          worktree: !!s.childWorkspaceIsolation,
        });
      }
    }
  } catch { /* store unavailable — skip */ }
  try {
    for (const w of listWorkers(workspaceRoot)) {
      if (w.status === 'running') tasks.push({ kind: 'worker', id: w.id, label: `${w.id} · ${w.role}`, startedAt: w.createdAt });
    }
  } catch { /* skip */ }
  try {
    for (const r of listRuns(workspaceRoot)) {
      if (r.status !== 'running') continue;
      // WF-BG + BUILD-LOOP P4 — surface the ACTIVE PHASE NAME for phase-aware
      // (run_workflow / build) runs, e.g. "slug · Implement (2/4)"; fall back to a
      // done/total count between phases.
      const label = workflowLabel(r);
      tasks.push({ kind: 'workflow', id: r.slug, label, startedAt: r.startedAt });
    }
  } catch { /* skip */ }
  // WS2 — agent-launched background shells (dev servers, long-running scripts)
  // were tracked only in an in-process registry the fleet never read. Surface
  // the running ones so they appear in the Background-tasks panel.
  try {
    for (const sh of listBackgroundShells()) {
      const t = shellRunToTask(sh);
      if (t) tasks.push(t);
    }
  } catch { /* skip */ }
  return tasks;
}

/**
 * The DURABLE background tasks that are still active (queued|running) for a
 * workspace — plan revisions, reviews, verification, attachment jobs. These are
 * file-backed (see `state/backgroundTaskStore`), so unlike `collectRunningTasks`
 * they survive a host restart and workspace/session switches. Callers merge
 * them with the live fleet to drive the desktop Background-tasks panel and the
 * sidebar "running" indicators. Best-effort: an unreadable store yields [].
 */
export function collectDurableRunningTasks(workspaceRoot: string): BackgroundTaskRecord[] {
  try {
    return listBackgroundTasks(workspaceRoot, { status: 'active' });
  } catch {
    return [];
  }
}

/**
 * Read a bounded dashboard inventory for one workspace: active work plus recent
 * terminal/stale records. This is intentionally richer than collectRunningTasks
 * so Desktop Dashboard can show failed/stale agents, workers, workflows, and
 * durable tasks instead of silently dropping them after they stop running.
 */
export function collectDashboardTasks(workspaceRoot: string, opts: { terminalLimit?: number } = {}): DashboardBackgroundTask[] {
  const terminalLimit = Math.max(0, opts.terminalLimit ?? 25);
  const out = new Map<string, DashboardBackgroundTask>();
  const add = (task: DashboardBackgroundTask): void => {
    const key = `${task.kind}:${task.id}`;
    if (!out.has(key)) out.set(key, task);
  };
  const includeRecent = <T extends { status: string; updatedAt?: string; createdAt?: string; startedAt?: string }>(rows: T[]): T[] => {
    let terminal = 0;
    return [...rows]
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? b.startedAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? a.startedAt ?? ''))
      .filter((row) => {
        if (row.status === 'queued' || row.status === 'pending' || row.status === 'running') return true;
        if (terminal >= terminalLimit) return false;
        terminal++;
        return true;
      });
  };

  try {
    for (const t of includeRecent(listBackgroundTasks(workspaceRoot, { status: 'all' }))) {
      add({
        kind: t.kind,
        id: t.id,
        label: t.title,
        startedAt: t.startedAt ?? t.createdAt,
        updatedAt: t.updatedAt,
        completedAt: t.completedAt,
        parentSessionKey: t.sessionKey,
        durable: true,
        status: t.status,
        phase: currentPhase(t),
        error: t.error,
        transcript: t.transcript,
        requirementId: t.requirementId,
        planId: t.planId,
      });
    }
  } catch { /* unreadable durable store */ }

  try {
    for (const s of includeRecent(listSessions(workspaceRoot))) {
      add({
        kind: 'agent',
        id: s.id,
        label: s.label ? `${s.label} (${s.id})` : s.id,
        status: s.status,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        completedAt: s.completedAt,
        error: s.error,
        role: s.role,
        worktree: !!s.childWorkspaceIsolation,
        parentSessionKey: s.parentSessionKey,
        transcript: { kind: 'agent', id: s.id, parentSessionKey: s.parentSessionKey },
      });
    }
  } catch { /* unreadable session store */ }

  try {
    for (const w of includeRecent(listWorkers(workspaceRoot))) {
      add({
        kind: 'worker',
        id: w.id,
        label: `${w.id} · ${w.role}`,
        status: w.status,
        startedAt: w.createdAt,
        updatedAt: w.updatedAt,
        role: w.role,
        parentSessionKey: w.parentSessionKey,
        transcript: { kind: 'worker', id: w.id, parentSessionKey: w.parentSessionKey ?? undefined },
      });
    }
  } catch { /* unreadable worker store */ }

  try {
    for (const r of includeRecent(listRuns(workspaceRoot))) {
      add({
        kind: 'workflow',
        id: r.slug,
        label: workflowLabel(r),
        status: r.status,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        parentSessionKey: r.sessionKey,
        transcript: { kind: 'workflow', id: r.slug, parentSessionKey: r.sessionKey ?? undefined },
      });
    }
  } catch { /* unreadable workflow store */ }

  return [...out.values()].sort((a, b) => {
    const ta = a.updatedAt ?? a.completedAt ?? a.startedAt ?? '';
    const tb = b.updatedAt ?? b.completedAt ?? b.startedAt ?? '';
    return tb.localeCompare(ta);
  });
}

export const GLYPH: Record<BackgroundTaskKind, string> = {
  workflow: '⟳',
  worker: '◆',
  agent: '◐',
  shell: '▶',
};

/**
 * Split running tasks into their three kinds, preserving order within each.
 * Pure — the sidebar renders each group as its own labeled section.
 */
export function groupTasksByKind(tasks: BackgroundTask[]): Record<BackgroundTaskKind, BackgroundTask[]> {
  const groups: Record<BackgroundTaskKind, BackgroundTask[]> = { agent: [], worker: [], workflow: [], shell: [] };
  for (const t of tasks) groups[t.kind].push(t);
  return groups;
}

/** Counts per kind, for the panel header. Pure. */
export function summarizeTasks(tasks: BackgroundTask[]): string {
  const by: Record<BackgroundTaskKind, number> = { agent: 0, worker: 0, workflow: 0, shell: 0 };
  for (const t of tasks) by[t.kind]++;
  const parts: string[] = [];
  if (by.workflow) parts.push(`${by.workflow} workflow${by.workflow === 1 ? '' : 's'}`);
  if (by.worker) parts.push(`${by.worker} worker${by.worker === 1 ? '' : 's'}`);
  if (by.agent) parts.push(`${by.agent} agent${by.agent === 1 ? '' : 's'}`);
  if (by.shell) parts.push(`${by.shell} shell${by.shell === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Render the task list to plain lines (caller colours). Returns [] when empty
 * so the panel hides. Pure. Each line: `  <glyph> <kind> <label>`.
 */
export function formatBackgroundTasks(tasks: BackgroundTask[], opts?: { max?: number }): string[] {
  if (!tasks.length) return [];
  const max = opts?.max ?? 8;
  // Workflows first, then workers, then agents — most-durable first.
  const order: BackgroundTaskKind[] = ['workflow', 'worker', 'agent'];
  const sorted = [...tasks].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const lines = sorted.slice(0, max).map((t) => `  ${GLYPH[t.kind]} ${t.kind} ${t.label}`);
  if (sorted.length > max) lines.push(`  …and ${sorted.length - max} more`);
  return lines;
}
