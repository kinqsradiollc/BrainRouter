/**
 * Sidebar workspace expansion — PERSISTED, user-controlled (0.4.15 workflow gaps,
 * fix 4). The left rail's project expand/collapse used to be transient React
 * state, so a refresh / app restart collapsed every workspace, and switching
 * away from the active (implicitly-expanded) workspace dropped it because the
 * active project's open-state lived in a different flag than the non-active
 * ones. This persists the expanded set per workspace path in localStorage so
 * expansion survives refresh, host reload, and workspace switches.
 *
 * Pure (localStorage access guarded) so it's unit-testable; the renderer loads
 * once on mount and saves on every change.
 */
const KEY = 'br-expanded-projects';

/** Read the persisted expanded-workspace list. Never throws; returns [] on any error. */
export function loadExpandedProjects(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the expanded-workspace list. Never throws. */
export function saveExpandedProjects(roots: string[]): void {
  try {
    const unique = Array.from(new Set(roots.filter((x) => typeof x === 'string')));
    globalThis.localStorage?.setItem(KEY, JSON.stringify(unique));
  } catch {
    /* storage unavailable / quota — expansion just won't persist this run */
  }
}

/**
 * Add a workspace to the expanded set (idempotent). Used when switching AWAY
 * from the active workspace so it stays expanded as a non-active row instead of
 * silently collapsing. Pure — returns the same reference when already present.
 */
export function withExpanded(roots: string[], root: string): string[] {
  if (!root || roots.includes(root)) return roots;
  return [...roots, root];
}

/** Toggle a workspace in the expanded set. Pure. */
export function toggleExpanded(roots: string[], root: string): string[] {
  return roots.includes(root) ? roots.filter((r) => r !== root) : [...roots, root];
}
