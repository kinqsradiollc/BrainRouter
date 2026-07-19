"use client";

/**
 * ADR-019 D1 — the single, app-wide organization/workspace context.
 *
 * Before this, every dashboard page independently listed orgs and re-derived an
 * "active org" (find(isDefault) ?? orgs[0]), passing an orgId per authFetch. This
 * provider makes that choice once for the whole authed shell so a top-of-sidebar
 * switcher can scope every page.
 *
 * Persistence is HYBRID: the selection is remembered in localStorage for instant
 * hydration, and mirrored to the server default org (best-effort) so the choice
 * follows the account across devices.
 */
import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { adminApi, type OrgSummary } from "../lib/adminApi";
import { useAuth } from "./AuthProvider";

const ACTIVE_ORG_STORAGE_KEY = "br-active-org";

interface OrgWorkspaceContextType {
  orgs: OrgSummary[];
  activeOrg: OrgSummary | null;
  activeOrgId: string;
  loading: boolean;
  error: string;
  setActiveOrg: (orgId: string) => void;
  refreshOrgs: () => Promise<void>;
}

const OrgWorkspaceContext = createContext<OrgWorkspaceContextType>({
  orgs: [],
  activeOrg: null,
  activeOrgId: "",
  loading: true,
  error: "",
  setActiveOrg: () => {},
  refreshOrgs: async () => {},
});

export function useActiveOrg(): OrgWorkspaceContextType {
  return useContext(OrgWorkspaceContext);
}

function readStoredOrgId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredOrgId(orgId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (orgId) window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    else window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode / blocked) — degrade gracefully */
  }
}

/** The active org for a freshly-loaded list: last chosen (if still a member),
 * else the server default, else the first org. Clears a stale stored id. */
function resolveActiveOrgId(orgs: OrgSummary[]): string {
  if (orgs.length === 0) return "";
  const stored = readStoredOrgId();
  if (stored && orgs.some((o) => o.orgId === stored)) return stored;
  if (stored) writeStoredOrgId(null); // membership lost — drop the stale pin
  const fallback = orgs.find((o) => o.isDefault) ?? orgs[0];
  return fallback.orgId;
}

export function OrgWorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOrgs = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const { orgs: fetched } = await adminApi.listOrgs(signal);
      if (signal?.aborted) return;
      setOrgs(fetched);
      // Keep the current selection if it survived the refresh; otherwise resolve
      // fresh (stored → default → first). Reading current state via the updater
      // avoids adding activeOrgId to the callback's dependencies.
      setActiveOrgId((current) =>
        current && fetched.some((o) => o.orgId === current) ? current : resolveActiveOrgId(fetched),
      );
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setOrgs([]);
      setActiveOrgId("");
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    void loadOrgs(controller.signal);
    return () => controller.abort();
  }, [isAuthenticated, loadOrgs]);

  const setActiveOrg = useCallback(
    (orgId: string) => {
      setOrgs((current) => {
        if (!current.some((o) => o.orgId === orgId)) return current; // guard: unknown id
        setActiveOrgId(orgId);
        writeStoredOrgId(orgId);
        // Mirror to the server default — best-effort, never blocks the UI.
        void adminApi.setDefaultOrg(orgId).catch(() => {});
        return current;
      });
    },
    [],
  );

  const refreshOrgs = useCallback(() => loadOrgs(), [loadOrgs]);

  const activeOrg = orgs.find((o) => o.orgId === activeOrgId) ?? null;

  return (
    <OrgWorkspaceContext.Provider
      value={{ orgs, activeOrg, activeOrgId, loading, error, setActiveOrg, refreshOrgs }}
    >
      {children}
    </OrgWorkspaceContext.Provider>
  );
}
