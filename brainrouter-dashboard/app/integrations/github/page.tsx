"use client";

/**
 * GitHub repo linking (ADR-014 Phase E) — the full setup flow for a Team, modeled
 * on a standard integrations page: connect the org's GitHub App, then LINK the
 * repos it can access to the memory system. A linked repo is a Project carrying the
 * repo URL; the memory system tracks it. Admin-only (RBAC: triggers:manage).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../components/AuthProvider";
import { AuthGuard } from "../../../components/AuthGuard";
import { PageHeader } from "../../../components/PageHeader";
import { PremiumCard } from "../../../components/PremiumCard";
import { PremiumButton } from "../../../components/PremiumButton";
import { adminApi, type OrgSummary, type Project } from "../../../lib/adminApi";

interface Repo { fullName: string; url: string; private: boolean; defaultBranch: string }
interface Status { configured: boolean; installed: boolean; installUrl?: string }

function ownerOf(repos: { fullName: string }[]): string {
  const first = repos[0]?.fullName ?? "";
  return first.includes("/") ? first.split("/")[0] : "";
}

function GithubInner() {
  const router = useRouter();
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState<string>("");
  const [status, setStatus] = useState<Status | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposError, setReposError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>("");

  // No global-admin gate — an org owner/admin manages their OWN org's GitHub here;
  // the backend enforces triggers:manage per-org (non-managers just see it read-only).
  useEffect(() => {
    (async () => {
      try {
        const res = await adminApi.listOrgs();
        setOrgs(res.orgs ?? []);
        // Honor ?org=<id> (deep-linked from the Organizations page), else the default.
        const wanted = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("org") : null;
        const pick = (wanted && res.orgs?.find((o) => o.orgId === wanted))
          ?? res.orgs?.find((o) => o.isDefault) ?? res.orgs?.[0];
        if (pick) setActiveOrg(pick.orgId);
      } catch (e) { setError(e instanceof Error ? e.message : "Failed to load organizations"); }
    })();
  }, []);

  const load = useCallback(async (orgId: string) => {
    if (!orgId) return;
    setLoading(true); setError(""); setReposError("");
    try {
      const [st, rp, pj] = await Promise.all([
        adminApi.githubStatus(orgId).catch(() => ({ configured: false, installed: false } as Status)),
        adminApi.githubRepos(orgId).catch(() => ({ configured: false, installed: false, repos: [], error: "Failed to load repositories" })),
        adminApi.listProjects(orgId).catch(() => ({ projects: [] as Project[] })),
      ]);
      setStatus(st);
      setRepos(rp.repos ?? []);
      if (rp.error) setReposError(rp.error);
      setProjects(pj.projects ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(activeOrg); }, [activeOrg, load]);

  // Linked = projects carrying a repoUrl. Accessible-but-unlinked = the add list.
  const linked = projects.filter((p) => p.repoUrl);
  const linkedUrls = new Set(linked.map((p) => (p.repoUrl ?? "").replace(/\.git$/, "")));
  const available = repos.filter((r) => !linkedUrls.has(r.url.replace(/\.git$/, "")));
  const shown = search.trim() ? available.filter((r) => r.fullName.toLowerCase().includes(search.trim().toLowerCase())) : available;
  const connectedOwner = ownerOf(repos);

  async function linkRepo(repo: Repo) {
    setBusy(repo.url);
    try {
      await adminApi.createProject(activeOrg, { name: repo.fullName, repoUrl: repo.url });
      setAdding(false); setSearch("");
      await load(activeOrg);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to link repository"); }
    finally { setBusy(""); }
  }
  async function unlink(p: Project) {
    setBusy(p.projectId);
    try { await adminApi.deleteProject(activeOrg, p.projectId); await load(activeOrg); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to remove repository"); }
    finally { setBusy(""); }
  }

  return (
    <div className="settings-page">
      <PageHeader title="GitHub" description="Manage access to private repositories through the BrainRouter GitHub App, then link repos to your memory." />
      <div className="settings-hint" style={{ marginTop: "calc(-1 * var(--spacing-8))" }}>
        <Link href="/integrations" className="settings-link">← All integrations</Link>
      </div>

      {orgs.length > 1 && (
        <label className="settings-label" style={{ maxWidth: "22rem", marginTop: "var(--spacing-16)" }}>Team
          <select className="settings-select" value={activeOrg} onChange={(e) => setActiveOrg(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      {/* Connection */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <div className="settings-cardhead"><div><h3>Connection</h3><div className="settings-hint">The Team&apos;s GitHub App installation.</div></div></div>
        {loading ? <div className="settings-empty-inline">Loading…</div> : status?.installed ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="prov-status prov-status--ok">✓ Connected{connectedOwner ? <> as <code>{connectedOwner}</code></> : ""}</span>
            <span style={{ flex: 1 }} />
            {status.installUrl && <a href={status.installUrl} target="_blank" rel="noreferrer"><PremiumButton size="small" variant="ghost">Configure repos on GitHub ↗</PremiumButton></a>}
            <PremiumButton size="small" variant="ghost" onClick={() => load(activeOrg)}>Refresh</PremiumButton>
          </div>
        ) : status?.configured ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="settings-hint">The App is configured but not installed on any org yet. Install it and grant repo access.</span>
            {status.installUrl && <a href={status.installUrl} target="_blank" rel="noreferrer"><PremiumButton size="small" variant="primary">Install GitHub App ↗</PremiumButton></a>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="settings-hint">No GitHub App configured for this Team.</span>
            <Link href="/integrations"><PremiumButton size="small" variant="primary">Configure the GitHub App</PremiumButton></Link>
          </div>
        )}
      </PremiumCard>

      {/* Repositories */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}>
        <div className="settings-cardhead">
          <div><h3>Repositories</h3><div className="settings-hint">Repositories linked to your memory system.</div></div>
          <PremiumButton size="small" variant="ghost" disabled={!status?.installed} onClick={() => { setAdding((v) => !v); setSearch(""); }}>
            {adding ? "Close" : "+ Add repository"}
          </PremiumButton>
        </div>

        {adding && (
          <div className="org-invite" style={{ display: "block" }}>
            <input className="settings-input" placeholder="Search repositories…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
            {reposError && <div className="settings-hint" style={{ color: "var(--danger)", marginTop: 6 }}>{reposError}</div>}
            <div className="prov-modellist" style={{ marginTop: 8 }}>
              {shown.length === 0 ? (
                <div className="settings-hint" style={{ padding: 10 }}>{available.length === 0 ? "All accessible repositories are already linked. Use “Configure repos on GitHub” to grant more." : `No repositories match “${search}”.`}</div>
              ) : shown.map((r) => (
                <div key={r.url} className="prov-modelrow">
                  <span className="org-member__id" title={r.fullName}>{r.fullName}{r.private && <span className="settings-badge settings-badge--muted" style={{ marginLeft: 6 }}>private</span>}</span>
                  <PremiumButton size="small" variant="primary" disabled={busy === r.url} onClick={() => linkRepo(r)}>{busy === r.url ? "Linking…" : "Link"}</PremiumButton>
                </div>
              ))}
            </div>
          </div>
        )}

        {linked.length === 0 ? (
          <div className="settings-empty-inline" style={{ marginTop: adding ? "var(--spacing-12)" : 0 }}>No repositories linked yet{status?.installed ? " — add one above." : "."}</div>
        ) : (
          <div style={{ marginTop: "var(--spacing-8)" }}>
            {linked.map((p) => {
              const url = (p.repoUrl ?? "").replace(/\.git$/, "");
              const branch = repos.find((r) => r.url.replace(/\.git$/, "") === url)?.defaultBranch ?? "main";
              return (
                <div key={p.projectId} className="org-member">
                  <div className="org-member__id" style={{ whiteSpace: "normal" }}>
                    <strong>{p.name}</strong>
                    <div className="settings-hint"><a href={p.repoUrl ?? "#"} target="_blank" rel="noreferrer" className="settings-link">{url}</a> · <code>{branch}</code></div>
                  </div>
                  <button className="org-iconbtn" title="Unlink repository" aria-label={`Unlink ${p.name}`} disabled={busy === p.projectId} onClick={() => unlink(p)}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

export default function GithubIntegrationPage() {
  return (
    <AuthGuard>
      <GithubInner />
    </AuthGuard>
  );
}
