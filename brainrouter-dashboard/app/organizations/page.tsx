"use client";

/**
 * ADR-010 P4 — Organizations. Create an org, see the orgs you belong to (role +
 * capabilities), switch your default, and — where you have members:manage —
 * invite members by email and set roles. Uses the app's premium blocks.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type OrgSummary, type OrgMember } from "../../lib/adminApi";

const ROLES = ["owner", "admin", "member", "viewer"];

function OrgsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({});
  const [invite, setInvite] = useState({ email: "", role: "member" });
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listOrgs();
      setOrgs(res.orgs ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organizations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    setCreating(true);
    try {
      await adminApi.createOrg(newOrgName.trim());
      setNewOrgName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }

  async function openMembers(org: OrgSummary) {
    if (expanded === org.orgId) { setExpanded(null); return; }
    setExpanded(org.orgId);
    if (!members[org.orgId] && org.capabilities.includes("members:manage")) {
      try {
        const res = await adminApi.listMembers(org.orgId);
        setMembers((m) => ({ ...m, [org.orgId]: res.members ?? [] }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load members");
      }
    }
  }

  async function inviteMember(orgId: string) {
    if (!invite.email.trim()) return;
    try {
      await adminApi.inviteMemberByEmail(orgId, invite.email.trim(), invite.role);
      const res = await adminApi.listMembers(orgId);
      setMembers((m) => ({ ...m, [orgId]: res.members ?? [] }));
      setInvite({ email: "", role: "member" });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to invite member");
    }
  }

  return (
    <div className="settings-page">
      <PageHeader title="Organizations" description="Create organizations, switch your default, and invite teammates by email with a role." />
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <div className="settings-cardhead"><h3>Create an organization</h3></div>
        <form onSubmit={createOrg} className="flex flex-wrap items-end gap-3">
          <label className="settings-label" style={{ flex: "1 1 16rem" }}>Name
            <input className="settings-input" placeholder="Acme Inc." value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} />
          </label>
          <PremiumButton type="submit" variant="primary" disabled={creating}>{creating ? "Creating…" : "Create organization"}</PremiumButton>
        </form>
      </PremiumCard>

      <div className="settings-stack">
        {loading ? (
          <div className="settings-empty-inline">Loading…</div>
        ) : orgs.length === 0 ? (
          <div className="settings-empty-inline">You don&apos;t belong to any organization yet.</div>
        ) : orgs.map((org) => (
          <PremiumCard key={org.orgId} level={2}>
            <div className="settings-cardhead">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 style={{ display: "inline" }}>{org.name}</h3>
                  <span className="settings-badge settings-badge--muted">{org.role}</span>
                  <span className="settings-badge settings-badge--muted">{org.plan}</span>
                  {org.isDefault && <span className="settings-badge settings-badge--default">default</span>}
                </div>
                <div className="settings-row__sub">{org.slug}</div>
              </div>
              <div className="settings-actions">
                {!org.isDefault && <PremiumButton size="small" variant="ghost" onClick={async () => { await adminApi.setDefaultOrg(org.orgId); await load(); }}>Make default</PremiumButton>}
                {org.capabilities.includes("members:manage") && (
                  <PremiumButton size="small" variant="text" onClick={() => openMembers(org)}>{expanded === org.orgId ? "Hide members" : "Members"}</PremiumButton>
                )}
              </div>
            </div>

            {expanded === org.orgId && org.capabilities.includes("members:manage") && (
              <div>
                {(members[org.orgId] ?? []).length === 0 ? (
                  <div className="settings-empty-inline">No members yet.</div>
                ) : (members[org.orgId] ?? []).map((m) => (
                  <div key={m.userId} className="settings-item">
                    <span className="settings-row__title truncate">{m.userId}</span>
                    <div className="settings-actions">
                      <span className="settings-hint">{m.role}</span>
                      <PremiumButton size="small" variant="danger" onClick={async () => { await adminApi.removeMember(org.orgId, m.userId); const res = await adminApi.listMembers(org.orgId); setMembers((mm) => ({ ...mm, [org.orgId]: res.members ?? [] })); }}>Remove</PremiumButton>
                    </div>
                  </div>
                ))}
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <label className="settings-label" style={{ flex: "1 1 14rem" }}>Invite by email
                    <input className="settings-input" type="email" placeholder="teammate@company.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
                  </label>
                  <label className="settings-label">Role
                    <select className="settings-select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <PremiumButton variant="primary" onClick={() => inviteMember(org.orgId)}>Invite</PremiumButton>
                </div>
              </div>
            )}
          </PremiumCard>
        ))}
      </div>
    </div>
  );
}

export default function OrganizationsPage() {
  return (
    <AuthGuard>
      <OrgsInner />
    </AuthGuard>
  );
}
