/**
 * Cross-workspace running indicators (0.4.15 workflow gaps, fix 4) — pure
 * derivations so the sidebar's per-workspace "running" dot + count come from
 * GLOBAL active-task state, not only the currently-selected session. A
 * background task in workspace A must stay visible (dot + count) while the user
 * is viewing workspace B, and survive workspace/session switches, refresh, and
 * host reload (the counts are sourced from the durable-merged global dashboard).
 *
 * Pure + unit-tested; the renderer wires the live `runningWs` set (turn-based)
 * together with these counts.
 */
import { isActiveTask, type DashTask } from './dashboard.js';

export interface DashboardWorkspace {
  workspaceRoot: string;
  tasks?: Array<Partial<DashTask>>;
}

/**
 * Active-task count per workspace. Non-active workspaces use the global
 * dashboard's (durable + live) task list; the ACTIVE workspace prefers its live
 * in-process fleet count, which is fresher than the polled dashboard.
 */
export function workspaceRunCounts(
  globalBoards: DashboardWorkspace[] | null,
  activeRoot: string | null,
  activeFleetCount: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of globalBoards ?? []) counts.set(b.workspaceRoot, (b.tasks ?? []).filter((t) => isActiveTask(t)).length);
  if (activeRoot) counts.set(activeRoot, activeFleetCount);
  return counts;
}

/**
 * The set of workspaces to show a "running" indicator for: the live turn-based
 * `runningWs` UNION every workspace with ≥1 active background task. Returns a
 * fresh set; callers pass it straight to the sidebar.
 */
export function runningWorkspaceSet(
  runningWs: Set<string>,
  counts: Map<string, number>,
): Set<string> {
  const s = new Set<string>(runningWs);
  for (const [root, n] of counts) if (n > 0) s.add(root);
  return s;
}
