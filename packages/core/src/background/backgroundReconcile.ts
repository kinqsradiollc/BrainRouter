/**
 * DESK-5w — reconcile stale background actors on startup.
 *
 * Child agents, workers and workflow runs execute IN-PROCESS: when the owning
 * process dies (the desktop app is closed, the CLI exits, a crash), they die
 * with it — but their on-disk state is left at `running`/`pending`. Without a
 * reconcile pass, a closed-then-reopened app shows phantom "running" background
 * tasks forever. This flips every actor whose owning pid is no longer alive to
 * a terminal state. Shared by the desktop host boot AND testable in isolation
 * (the real-pid `isAlive` is injectable).
 */
import { listWorkers, staleWorkerIds, updateWorkerMeta } from '../worker/workerStore.js';
import { listSessions, updateSession } from '../orchestration/session/orchestrator.js';
import { listRuns, finishRun, staleRunSlugs } from '../workflow/run/workflowRun.js';

/**
 * Real OS process liveness: `kill(pid, 0)` throws ESRCH when the process is
 * gone, EPERM when it exists but isn't ours (still alive). A null/0 pid is
 * treated as dead. NOT "pid === process.pid", so a CLI running its OWN live
 * workers alongside the desktop app isn't falsely reaped.
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface ReconcileResult { sessions: number; workers: number; runs: number }

/**
 * Flip running/pending background actors whose owning process is dead to a
 * terminal state. Returns how many of each kind were reconciled. Best-effort:
 * a missing/locked store for one kind never blocks the others.
 */
export function reconcileStaleBackgroundTasks(
  workspaceRoot: string,
  isAlive: (pid: number | null | undefined) => boolean = pidAlive,
): ReconcileResult {
  let sessions = 0, workers = 0, runs = 0;
  try {
    for (const s of listSessions(workspaceRoot)) {
      if ((s.status === 'running' || s.status === 'pending') && !isAlive(s.pid)) {
        updateSession(workspaceRoot, s.id, { status: 'stale' });
        sessions++;
      }
    }
  } catch { /* store unavailable — skip */ }
  try {
    for (const id of staleWorkerIds(listWorkers(workspaceRoot), isAlive)) {
      updateWorkerMeta(workspaceRoot, id, { status: 'failed' });
      workers++;
    }
  } catch { /* skip */ }
  try {
    for (const slug of staleRunSlugs(listRuns(workspaceRoot), isAlive)) {
      finishRun(workspaceRoot, slug, 'failed');
      runs++;
    }
  } catch { /* skip */ }
  return { sessions, workers, runs };
}
