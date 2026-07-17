/**
 * §7 — the pure gate→UI decisions, shared by the Diff panel (button states) and
 * runGit (commit/push labelling). Kept out of the components so they're testable.
 */
export function commitBlocked(gate: { blocked?: boolean } | null | undefined, changedCount: number): boolean {
  // Only block when there's actually something to commit AND the gate refuses.
  return !!gate?.blocked && changedCount > 0;
}

/** How a commit/push was cleared — drives the toast/log. A CLEAN gate is
 *  'reviewed', NOT 'bypassed': only an explicit user bypass is 'bypassed'. */
export function gitActionTag(opts?: { bypass?: boolean; reviewed?: boolean }): '' | 'reviewed' | 'bypassed' {
  if (opts?.bypass) return 'bypassed';
  if (opts?.reviewed) return 'reviewed';
  return '';
}
