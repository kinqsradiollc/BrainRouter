/**
 * Pure helpers for keying review state by workspace (T2). The renderer keeps
 * reviewByWorkspace / reviewGateByWorkspace / reviewRunningByWorkspace maps and
 * derives the ACTIVE workspace's view through these, so one workspace's findings
 * can never paint into another's, and a clean gate from workspace A can never
 * clear a commit triggered in workspace B.
 */
export interface GateLike { status: string; blocked: boolean; reason: string }

/** The entry for the active workspace root, or null. */
export function activeEntry<T>(byWs: Record<string, T>, root: string | null | undefined): T | null {
  if (!root) return null;
  return byWs[root] ?? null;
}

/** Immutably set one workspace's entry (never mutates other workspaces). */
export function setEntry<T>(byWs: Record<string, T>, root: string, value: T): Record<string, T> {
  return { ...byWs, [root]: value };
}

/** Immutably drop a workspace's entry (e.g. on close). */
export function dropEntry<T>(byWs: Record<string, T>, root: string): Record<string, T> {
  if (!(root in byWs)) return byWs;
  const next = { ...byWs };
  delete next[root];
  return next;
}

/**
 * Stale-action guard for the commit/push gate: only proceed with a gate-driven
 * git action if the workspace the gate result is for is STILL the active one.
 * Prevents a clean gate from A clearing a commit started in B during a switch.
 */
export function shouldProceedGate(resultRoot: string | null | undefined, activeRoot: string | null | undefined): boolean {
  return !!resultRoot && !!activeRoot && resultRoot === activeRoot;
}

export type ReviewBadge = 'needs-review' | 'reviewing' | 'blocked' | 'passed' | 'stale' | null;

/**
 * Sidebar review badge for a workspace, from its stored gate + changed-file
 * count (+ whether a review is running there). Suppressed when there's nothing
 * to review (clean/needs-review with zero changes) so idle projects stay quiet.
 */
export function reviewBadgeFor(gate: GateLike | null | undefined, changedCount: number, running?: boolean): ReviewBadge {
  if (running) return 'reviewing';
  if (!gate) return changedCount > 0 ? 'needs-review' : null;
  switch (gate.status) {
    case 'blocked': return 'blocked';
    case 'stale': return 'stale';
    case 'running': return 'reviewing';
    case 'needs-review': return changedCount > 0 ? 'needs-review' : null;
    case 'clean': return changedCount > 0 ? 'passed' : null;
    default: return null;
  }
}
