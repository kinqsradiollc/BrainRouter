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
import { listWorkers } from '../state/workerStore.js';
import { listSessions } from '../orchestration/orchestrator.js';
import { listRuns, summarizePhases, formatActivePhase } from '../state/workflowRun.js';

export type BackgroundTaskKind = 'agent' | 'worker' | 'workflow';

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
      let label = r.slug;
      if (r.phases && r.phases.length > 0) {
        const active = formatActivePhase(r);
        if (active) {
          label = `${r.slug} · ${active}`;
        } else {
          const { done, total } = summarizePhases(r);
          label = `${r.slug} · phase ${done}/${total}`;
        }
      }
      tasks.push({ kind: 'workflow', id: r.slug, label, startedAt: r.startedAt });
    }
  } catch { /* skip */ }
  return tasks;
}

export const GLYPH: Record<BackgroundTaskKind, string> = {
  workflow: '⟳',
  worker: '◆',
  agent: '◐',
};

/**
 * Split running tasks into their three kinds, preserving order within each.
 * Pure — the sidebar renders each group as its own labeled section.
 */
export function groupTasksByKind(tasks: BackgroundTask[]): Record<BackgroundTaskKind, BackgroundTask[]> {
  const groups: Record<BackgroundTaskKind, BackgroundTask[]> = { agent: [], worker: [], workflow: [] };
  for (const t of tasks) groups[t.kind].push(t);
  return groups;
}

/** Counts per kind, for the panel header. Pure. */
export function summarizeTasks(tasks: BackgroundTask[]): string {
  const by: Record<BackgroundTaskKind, number> = { agent: 0, worker: 0, workflow: 0 };
  for (const t of tasks) by[t.kind]++;
  const parts: string[] = [];
  if (by.workflow) parts.push(`${by.workflow} workflow${by.workflow === 1 ? '' : 's'}`);
  if (by.worker) parts.push(`${by.worker} worker${by.worker === 1 ? '' : 's'}`);
  if (by.agent) parts.push(`${by.agent} agent${by.agent === 1 ? '' : 's'}`);
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
