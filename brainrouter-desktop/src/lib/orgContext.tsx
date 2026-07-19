/**
 * Desktop mirror of the dashboard's OrgWorkspaceProvider (ADR-019 D1) — ONE
 * app-wide organization/workspace context.
 *
 * Before this, MeetingsView independently listed the account's org contexts and
 * re-derived an active org behind a per-view picker. This provider makes that
 * choice once for the whole app so the activity-bar switcher can scope every
 * org-aware surface (Meetings, its Track board, team sharing).
 *
 * The selection persists in localStorage for instant re-hydration. Signed-out
 * (or browser-dev without a teams bridge) simply yields no contexts — consumers
 * fall back to the server-default context exactly as before.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTeamsOps, type TeamContext } from '../components/meetings/teamsOps.js';

const ACTIVE_ORG_STORAGE_KEY = 'br-active-org';

export interface WorkspaceOrg {
  contexts: TeamContext[];
  activeOrgId: string;
  activeContext: TeamContext | undefined;
  /** Guarded id for API calls — only ever an org the account was actually shown. */
  scopedOrgId: string | undefined;
  setActiveOrg: (orgId: string) => void;
  refresh: () => Promise<void>;
}

const WorkspaceOrgContext = createContext<WorkspaceOrg>({
  contexts: [], activeOrgId: '', activeContext: undefined, scopedOrgId: undefined,
  setActiveOrg: () => {}, refresh: async () => {},
});

export function useActiveOrg(): WorkspaceOrg {
  return useContext(WorkspaceOrgContext);
}

function readStoredOrgId(): string | null {
  try { return localStorage.getItem(ACTIVE_ORG_STORAGE_KEY); } catch { return null; }
}
function writeStoredOrgId(orgId: string | null): void {
  try {
    if (orgId) localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    else localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  } catch { /* storage unavailable — degrade to session-only selection */ }
}

export function WorkspaceOrgProvider({ children }: { children: ReactNode }): React.ReactElement {
  const teamsOps = useMemo(() => createTeamsOps(), []);
  const [contexts, setContexts] = useState<TeamContext[]>([]);
  const [activeOrgId, setActiveOrgId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const rows = await teamsOps.contexts();
      setContexts(rows);
      // Keep the current selection if it survived; else last chosen (if still a
      // member) → server default → first. A stale stored pin is dropped.
      setActiveOrgId((current) => {
        if (current && rows.some((row) => row.orgId === current)) return current;
        const stored = readStoredOrgId();
        if (stored && rows.some((row) => row.orgId === stored)) return stored;
        if (stored) writeStoredOrgId(null);
        return rows.find((row) => row.isDefault)?.orgId ?? rows[0]?.orgId ?? '';
      });
    } catch { /* signed out / offline — org-aware surfaces use the default context */ }
  }, [teamsOps]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setActiveOrg = useCallback((orgId: string) => {
    setContexts((current) => {
      if (!current.some((row) => row.orgId === orgId)) return current; // guard: unknown id
      setActiveOrgId(orgId);
      writeStoredOrgId(orgId);
      return current;
    });
  }, []);

  const activeContext = contexts.find((row) => row.orgId === activeOrgId);
  const value = useMemo<WorkspaceOrg>(() => ({
    contexts, activeOrgId, activeContext,
    // Guarded: derived from the loaded list, so a tampered id can never reach the API.
    scopedOrgId: activeContext?.orgId,
    setActiveOrg, refresh,
  }), [contexts, activeOrgId, activeContext, setActiveOrg, refresh]);

  return <WorkspaceOrgContext.Provider value={value}>{children}</WorkspaceOrgContext.Provider>;
}
