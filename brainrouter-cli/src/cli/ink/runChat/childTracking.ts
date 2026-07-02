import { listSessions, reconcileStale } from '@kinqs/brainrouter-core/orchestration';
import { reconcileOrphanWorktrees } from '@kinqs/brainrouter-core/worktree';
import { reconcileStaleWorkers, listWorkers } from '@kinqs/brainrouter-core/worker';
import { reconcileStaleRuns, listRuns } from '@kinqs/brainrouter-core/workflow';
import { collectRunningTasks } from '@kinqs/brainrouter-core/background';
import type { RunChatContext } from './context.js';

// Live-refresh cadence for the fleet sidebar. The sidebar path
// (collectRunningTasks) is just plain JSON reads, so it runs every second for
// real-time appearance / elapsed ticking. The EXPENSIVE count
// (getRunningChildCount → reconcile + git-worktree GC) is throttled to every
// Nth tick so we never spawn git every second.
const SIDEBAR_REFRESH_MS = 1000;
const GC_EVERY_N_TICKS = 3;

/**
 * Background-actor counting + the live footer/sidebar refresh ticker. Owns
 * the "· N working" footer pill and the fleet sidebar's Sub-agents section,
 * reconciling stale child/worker/workflow records from prior CLI processes.
 */
export function installChildTracking(ctx: RunChatContext): void {
  const { agent } = ctx;

  ctx.getRunningChildCount = (): number => {
    try {
      // Reconcile first so child records from prior CLI processes (dead
      // pids) don't get counted as "working". Without this the footer
      // showed phantom "· N working" forever for zombies left over by an
      // earlier crash / Ctrl-C exit. reconcileStale is idempotent and
      // only writes the JSON file when there were actual stale entries
      // to flip — subsequent calls are pure reads.
      reconcileStale(agent.workspaceRoot);
      // Snapshot the LIVE (running/pending) children AFTER reconcileStale has flipped
      // any dead-pid sessions — these ids guard their worktrees from the GC below.
      const sessions = listSessions(agent.workspaceRoot);
      const liveChildIds = sessions.filter((s) => s.status === 'pending' || s.status === 'running').map((s) => s.id);
      // CODEX-WORKTREE-CLEANUP — GC orphan child worktrees left under the worktree
      // base by a crashed prior process (git worktree prune + rm untracked dirs).
      // `keepChildIds` ensures a RUNNING child's worktree is never deleted out from
      // under it (the live-child GC bug). Best-effort + idempotent.
      try { reconcileOrphanWorktrees(agent.workspaceRoot, { keepChildIds: liveChildIds }); } catch { /* best-effort */ }
      // MAS-P5-T3: same treatment for worker threads — a `running` worker
      // from a dead CLI process can't resume mid-turn, so flip it to failed.
      reconcileStaleWorkers(agent.workspaceRoot);
      // PARITY-W1: durable workflow runs left `running` by a dead process are
      // flipped to `interrupted` so the /workflows viewer is honest on restart.
      reconcileStaleRuns(agent.workspaceRoot);
      return liveChildIds.length;
    } catch {
      return 0;
    }
  };

  ctx.getRunningWorkerCount = (): number => {
    try { return listWorkers(agent.workspaceRoot).filter((w) => w.status === 'running').length; }
    catch { return 0; }
  };
  ctx.getRunningWorkflowCount = (): number => {
    try { return listRuns(agent.workspaceRoot).filter((r) => r.status === 'running').length; }
    catch { return 0; }
  };
  // BG-TASKS-PANEL — push the live running-tasks list into the panel.
  ctx.refreshBackgroundTasks = (): void => {
    try { ctx.controller?.setBackgroundTasks(collectRunningTasks(agent.workspaceRoot)); }
    catch { /* panel refresh must never break the REPL */ }
  };

  // Cheap "is anything live?" probe (no reconcile / worktree GC) for the
  // ticker's own start/stop lifecycle.
  ctx.hasLiveActors = (): boolean => {
    try {
      if (listSessions(agent.workspaceRoot).some((s) => s.status === 'running' || s.status === 'pending')) return true;
    } catch { /* ignore */ }
    return ctx.getRunningWorkerCount() > 0 || ctx.getRunningWorkflowCount() > 0;
  };
  ctx.tickChildRefresh = () => {
    // Cheap, EVERY tick → live sidebar (sub-agents appear/clear) + elapsed ticks.
    ctx.refreshBackgroundTasks();
    // PARITY-W3: announce any background actor that finished since last tick.
    ctx.notifyIdleCompletions();
    // Expensive (reconcile + worktree GC), THROTTLED → footer "· N working".
    // Gated so a childless turn never spawns git: only runs while actors are
    // live, or to wind the count back down to 0 after they finish.
    ctx.refreshTickN = (ctx.refreshTickN + 1) % GC_EVERY_N_TICKS;
    if (ctx.refreshTickN === 0 && (ctx.lastChildCount > 0 || ctx.hasLiveActors())) {
      const count = ctx.getRunningChildCount();
      if (count !== ctx.lastChildCount) {
        ctx.lastChildCount = count;
        ctx.refreshFooter();
      }
    }
    // Keep ticking while a turn is ACTIVE (children may spawn at any moment) or
    // while any background actor is live. Stop only once the turn is over AND
    // nothing is left running (cheap check — no GC).
    if (!ctx.isProcessing && !ctx.hasLiveActors() && ctx.childRefreshTimer) {
      clearInterval(ctx.childRefreshTimer);
      ctx.childRefreshTimer = null;
      ctx.refreshBackgroundTasks(); // final sweep → clears the panel when all done
    }
  };
  ctx.ensureChildRefreshTimer = () => {
    if (ctx.childRefreshTimer) return;
    // Run while a turn is active (so mid-turn spawns show up live) OR when
    // something is already running in the background.
    if (!ctx.isProcessing && !ctx.hasLiveActors()) return;
    ctx.childRefreshTimer = setInterval(ctx.tickChildRefresh, SIDEBAR_REFRESH_MS);
  };
}
