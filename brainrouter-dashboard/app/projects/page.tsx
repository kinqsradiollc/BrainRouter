"use client";

/**
 * ADR-014 Phase E — Projects. Pick a Team, see/create its projects (repos), and
 * mark a project restricted (enterprise). Plan caps + access control are enforced
 * server-side; the UI reflects the errors.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type OrgSummary, type Project } from "../../lib/adminApi";

function ProjectsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState<string>("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", repoUrl: "", restricted: false });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await adminApi.listOrgs();
        setOrgs(res.orgs ?? []);
        const def = (res.orgs ?? []).find((o) => o.isDefault) ?? (res.orgs ?? [])[0];
        if (def) setActiveOrg(def.orgId);
      } catch (e) { setError(e instanceof Error ? e.message : "Failed to load teams"); }
    })();
  }, []);

  const loadProjects = useCallback(async (orgId: string) => {
    if (!orgId) return;
    try {
      const res = await adminApi.listProjects(orgId);
      setProjects(res.projects ?? []);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load projects"); }
  }, []);

  useEffect(() => { void loadProjects(activeOrg); }, [activeOrg, loadProjects]);

  const org = orgs.find((o) => o.orgId === activeOrg);
  const canManage = !!org?.capabilities.includes("members:manage");
  const canRestrict = !!org?.entitlements?.features?.includes("restrictedProjects");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !activeOrg) return;
    setCreating(true);
    try {
      await adminApi.createProject(activeOrg, { name: form.name.trim(), repoUrl: form.repoUrl.trim() || undefined, restricted: form.restricted });
      setForm({ name: "", repoUrl: "", restricted: false });
      await loadProjects(activeOrg);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to create project"); }
    finally { setCreating(false); }
  }

  async function remove(projectId: string) {
    try { await adminApi.deleteProject(activeOrg, projectId); await loadProjects(activeOrg); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to delete"); }
  }

  return (
    <div className="settings-page">
      <PageHeader title="Projects" description="Repos and projects inside a team. Plan-capped; restrict a project to specific members on the enterprise plan." />
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <label className="settings-label" style={{ maxWidth: "20rem" }}>Team
          <select className="settings-select" value={activeOrg} onChange={(e) => setActiveOrg(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
      </PremiumCard>

      {canManage && (
        <PremiumCard level={2}>
          <div className="settings-cardhead"><h3>New project</h3></div>
          <form onSubmit={create} className="org-create">
            <label className="settings-label org-create__name">Name
              <input className="settings-input" placeholder="payments-service" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="settings-label org-create__plan">Repo URL (optional)
              <input className="settings-input" placeholder="https://github.com/acme/repo" value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
            </label>
            <div className="org-create__foot">
              <PremiumButton type="submit" variant="primary" disabled={creating || !form.name.trim()}>{creating ? "Creating…" : "Create project"}</PremiumButton>
              {canRestrict && (
                <label className="settings-check"><input type="checkbox" checked={form.restricted} onChange={(e) => setForm({ ...form, restricted: e.target.checked })} /> Restricted (members only)</label>
              )}
            </div>
          </form>
        </PremiumCard>
      )}

      <div className="settings-stack">
        {projects.length === 0 ? (
          <div className="settings-empty-inline">No projects in this team yet.</div>
        ) : projects.map((p) => (
          <PremiumCard key={p.projectId} level={2}>
            <div className="org-head">
              <div className="org-headmeta">
                <h3 className="org-name">
                  {p.name}
                  {p.restricted && <span className="settings-badge settings-badge--muted">restricted</span>}
                </h3>
                <div className="org-sub">
                  <span className="org-sub__slug">{p.slug}</span>
                  {p.repoUrl && (<><span className="org-sub__dot">·</span><span>{p.repoUrl}</span></>)}
                </div>
              </div>
              {canManage && (
                <div className="settings-actions">
                  <PremiumButton size="small" variant="danger" onClick={() => remove(p.projectId)}>Delete</PremiumButton>
                </div>
              )}
            </div>
          </PremiumCard>
        ))}
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  return <AuthGuard><ProjectsInner /></AuthGuard>;
}
