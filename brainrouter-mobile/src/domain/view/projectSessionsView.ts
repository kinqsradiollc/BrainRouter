import type { SessionRow } from '../../types.js';
import { moreLabel, showToggle, toggleVisible } from '../session/sessionPagination.js';

export const PROJECT_SESSION_BASE = 6;
export const PROJECT_SESSION_PAGE = 10;
export const PROJECT_SESSION_STALE_MS = 5 * 60_000;

export interface ProjectSessionsState {
  rows: SessionRow[];
  loading: boolean;
  error: string | null;
  loadedAt: number;
  truncated?: boolean;
}

export type ProjectSessionsByRoot = Record<string, ProjectSessionsState>;

export function sidebarProjectRoots(current: string | null | undefined, recents: string[]): string[] {
  const roots = [...new Set(recents.filter((r) => typeof r === 'string' && r.trim()))];
  if (!current) return roots;
  return roots.includes(current) ? roots : [current, ...roots];
}

export function reorderProjectRoots(roots: string[], dragged: string, target: string): string[] {
  const unique = [...new Set(roots.filter((r) => typeof r === 'string' && r.trim()))];
  const from = unique.indexOf(dragged);
  const to = unique.indexOf(target);
  if (from < 0 || to < 0 || from === to) return unique;
  const next = [...unique];
  const [item] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, item);
  return next;
}

export function loadingProjectSessions(prev?: ProjectSessionsState, now = Date.now()): ProjectSessionsState {
  return {
    rows: prev?.rows ?? [],
    loading: true,
    error: null,
    loadedAt: prev?.loadedAt ?? 0,
    truncated: prev?.truncated,
  };
}

export function normalizeProjectSessionsResult(result: unknown, now = Date.now()): ProjectSessionsState {
  if (Array.isArray(result)) {
    return { rows: result as SessionRow[], loading: false, error: null, loadedAt: now };
  }
  if (result && typeof result === 'object') {
    const r = result as { rows?: unknown; error?: unknown; truncated?: unknown };
    if (Array.isArray(r.rows)) {
      return {
        rows: r.rows as SessionRow[],
        loading: false,
        error: typeof r.error === 'string' && r.error.trim() ? r.error : null,
        loadedAt: now,
        truncated: r.truncated === true,
      };
    }
    if (typeof r.error === 'string' && r.error.trim()) {
      return { rows: [], loading: false, error: r.error, loadedAt: now };
    }
  }
  return { rows: [], loading: false, error: 'Could not load chats for this project.', loadedAt: now };
}

export function withCachedProjectSessions(
  prev: ProjectSessionsByRoot,
  root: string | null | undefined,
  rows: SessionRow[],
  now = Date.now(),
): ProjectSessionsByRoot {
  if (!root) return prev;
  const prior = prev[root];
  return {
    ...prev,
    [root]: {
      rows,
      loading: false,
      error: null,
      loadedAt: now,
      truncated: prior?.truncated,
    },
  };
}

export function projectSessionsNeedRefresh(
  state: ProjectSessionsState | undefined,
  now = Date.now(),
  staleMs = PROJECT_SESSION_STALE_MS,
): boolean {
  if (!state) return true;
  if (state.loading) return false;
  if (state.loadedAt <= 0) return true;
  return now - state.loadedAt > staleMs;
}

export function projectSessionMatches(row: SessionRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = row.firstUserMessage ?? '';
  return title.toLowerCase().includes(q) || row.sessionKey.toLowerCase().includes(q);
}

export function projectMatches(root: string, rows: SessionRow[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = root.split('/').filter(Boolean).pop() ?? root;
  return root.toLowerCase().includes(q) || name.toLowerCase().includes(q) || rows.some((row) => projectSessionMatches(row, q));
}

export function filterProjectSessions(rows: SessionRow[], query: string): SessionRow[] {
  const q = query.trim();
  return q ? rows.filter((row) => projectSessionMatches(row, q)) : rows;
}

export function visibleProjectSessions(rows: SessionRow[], query: string, visibleCount: number): SessionRow[] {
  return filterProjectSessions(rows, query).slice(0, Math.max(PROJECT_SESSION_BASE, visibleCount));
}

export function nextProjectVisibleCount(current: number, total: number): number {
  return toggleVisible(current || PROJECT_SESSION_BASE, total, PROJECT_SESSION_PAGE, PROJECT_SESSION_BASE);
}

export function projectMoreLabel(total: number, visible: number): string {
  return moreLabel(total, visible, PROJECT_SESSION_BASE);
}

export function shouldShowProjectToggle(total: number, visible: number): boolean {
  return showToggle(total, visible, PROJECT_SESSION_BASE);
}
