/**
 * T4 — sidebar session groupings. Pure derived state (memoised) from the
 * sessions list + workspace info: hide archived (unless toggled), pinned
 * first, optional alpha sort, split grouped chats into their own sections,
 * and compute the visible/hidden window + the fixed project-root list. Extracted
 * verbatim from App.tsx.
 */
import { useMemo } from 'react';
import type { SessionRow } from '../../types.js';
import { sidebarProjectRoots } from './projectSessionsView.js';

export interface SessionSidebarInput {
  sessions: SessionRow[];
  showArchived: boolean;
  recentsSort: 'recent' | 'alpha';
  recentsOpen: boolean;
  visibleCount: number;
  workspaces: { current: string | null; recents: string[] };
  info: { workspaceRoot?: string };
}

export interface SessionSidebar {
  archivedCount: number;
  ungroupedSessions: SessionRow[];
  groupedSessions: Array<[string, SessionRow[]]>;
  visibleProjectSessions: SessionRow[];
  hiddenProjectSessions: number;
  projectRoots: string[];
}

export function useSessionSidebar(i: SessionSidebarInput): SessionSidebar {
  const { sessions, showArchived, recentsSort, recentsOpen, visibleCount, workspaces, info } = i;

  // DESK-6m — hide archived (unless toggled), keep pinned first, optionally
  // alpha-sort, and split out grouped chats into their own sections.
  const liveSessions = useMemo(() => {
    let list = sessions.filter((s) => showArchived || !s.archived);
    if (recentsSort === 'alpha') list = [...list].sort((a, b) => (a.firstUserMessage ?? a.sessionKey).localeCompare(b.firstUserMessage ?? b.sessionKey));
    return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)); // pinned first (stable)
  }, [sessions, showArchived, recentsSort]);
  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions]);
  const ungroupedSessions = useMemo(() => liveSessions.filter((s) => !s.group), [liveSessions]);
  const groupedSessions = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of liveSessions) if (s.group) { const arr = m.get(s.group); if (arr) arr.push(s); else m.set(s.group, [s]); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [liveSessions]);
  const visibleProjectSessions = recentsOpen ? ungroupedSessions.slice(0, visibleCount) : ungroupedSessions.slice(0, 3);
  const hiddenProjectSessions = Math.max(0, ungroupedSessions.length - visibleProjectSessions.length);
  const activeRoot = workspaces.current ?? info.workspaceRoot ?? null;
  const projectRoots = useMemo(() => sidebarProjectRoots(activeRoot, workspaces.recents), [activeRoot, workspaces.recents]);

  return { archivedCount, ungroupedSessions, groupedSessions, visibleProjectSessions, hiddenProjectSessions, projectRoots };
}
