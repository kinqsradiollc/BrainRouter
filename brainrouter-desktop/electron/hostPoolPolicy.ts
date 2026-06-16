/**
 * Multi-workspace host pool policy (stability items 3 + 4) — pure decision
 * layer, no Electron objects, so it is fully unit-testable.
 *
 * THE BUG it fixes: the old model retired (killed) a window's single host every
 * time you switched the workspace inside it. Running work in workspace A died
 * the instant you looked at workspace B. Here a window keeps a *pool* of hosts
 * keyed by workspaceRoot; switching only changes which host is ACTIVE (drives
 * the chat surface). A non-active host is reaped ONLY when it is idle (no turn
 * in flight) and has been left alone past a TTL — never while it is running,
 * never the active one, and never the one you just left (its idle clock starts
 * the moment you leave it).
 *
 * main.ts maps a plan onto real UtilityProcess fork/kill calls and keeps the
 * pure state via applyActivate/setRunning; everything below is deterministic.
 */

export interface HostPoolEntry {
  workspaceRoot: string;
  /** A turn (or a descendant task) is in flight — this host must NOT be reaped. */
  running: boolean;
  /** ms-epoch when this workspace was last active (i.e. last left). Idle clock. */
  lastActiveAt: number;
}

export interface HostPoolState {
  entries: HostPoolEntry[];
  activeRoot: string | null;
}

export interface ActivatePlan {
  /** reuse an existing host for this workspace, or spawn a fresh one. */
  mode: 'reuse' | 'spawn';
  activeRoot: string;
  /** workspaceRoots whose (idle, non-active) hosts should be shut down now. */
  reap: string[];
}

/** A workspace left idle longer than this with no running work is reaped. */
export const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export function emptyPool(): HostPoolState {
  return { entries: [], activeRoot: null };
}

/**
 * Decide what activating `workspaceRoot` implies, WITHOUT mutating state.
 * Reuse if a host already exists; otherwise spawn. Reap the idle stragglers,
 * but never the incoming workspace, never the one being left (activeRoot),
 * and never anything with work in flight.
 */
export function planActivate(
  state: HostPoolState,
  workspaceRoot: string,
  now: number,
  ttlMs: number = DEFAULT_IDLE_TTL_MS,
): ActivatePlan {
  const exists = state.entries.some((e) => e.workspaceRoot === workspaceRoot);
  const reap = state.entries
    .filter(
      (e) =>
        e.workspaceRoot !== workspaceRoot && // never the one we're switching to
        e.workspaceRoot !== state.activeRoot && // never the one we're leaving (idle clock starts now)
        !e.running && // NEVER kill work in flight — the whole point of the pool
        now - e.lastActiveAt > ttlMs,
    )
    .map((e) => e.workspaceRoot);
  return { mode: exists ? 'reuse' : 'spawn', activeRoot: workspaceRoot, reap };
}

/** Fold a plan into new pool state: drop reaped hosts, add/refresh the active. */
export function applyActivate(
  state: HostPoolState,
  plan: ActivatePlan,
  now: number,
): HostPoolState {
  let entries = state.entries.filter((e) => !plan.reap.includes(e.workspaceRoot));
  // Start the idle clock on the workspace we're leaving (so it's eligible for
  // reaping only after a full TTL of being unviewed — not retroactively).
  if (state.activeRoot && state.activeRoot !== plan.activeRoot) {
    entries = entries.map((e) =>
      e.workspaceRoot === state.activeRoot ? { ...e, lastActiveAt: now } : e,
    );
  }
  if (!entries.some((e) => e.workspaceRoot === plan.activeRoot)) {
    entries = [...entries, { workspaceRoot: plan.activeRoot, running: false, lastActiveAt: now }];
  } else {
    entries = entries.map((e) =>
      e.workspaceRoot === plan.activeRoot ? { ...e, lastActiveAt: now } : e,
    );
  }
  return { entries, activeRoot: plan.activeRoot };
}

/** Mark a workspace's host busy/idle (driven by turn-start / turn-end events). */
export function setRunning(
  state: HostPoolState,
  workspaceRoot: string,
  running: boolean,
): HostPoolState {
  return {
    ...state,
    entries: state.entries.map((e) =>
      e.workspaceRoot === workspaceRoot ? { ...e, running } : e,
    ),
  };
}

/** Remove a host (e.g. its process exited) from the pool. */
export function removeEntry(state: HostPoolState, workspaceRoot: string): HostPoolState {
  return {
    entries: state.entries.filter((e) => e.workspaceRoot !== workspaceRoot),
    activeRoot: state.activeRoot === workspaceRoot ? null : state.activeRoot,
  };
}

/** Workspaces (other than the viewed one) that currently have work in flight — drives the sidebar "running elsewhere" hint. */
export function runningRoots(state: HostPoolState, exclude?: string): string[] {
  return state.entries
    .filter((e) => e.running && e.workspaceRoot !== exclude)
    .map((e) => e.workspaceRoot);
}
