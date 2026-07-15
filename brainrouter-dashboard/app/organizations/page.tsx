"use client";

/**
 * ADR-010 P4 — Organizations. Create an org, see the orgs you belong to (role +
 * capabilities), switch your default, and — where you have members:manage —
 * invite members by email, change their role, or remove them. Premium blocks.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, ORG_PLANS, type OrgSummary, type OrgMember, type OrgPlan, type SharedMemory } from "../../lib/adminApi";
import { InlineLoading } from "../../components/LoadingSpinner";

const ROLES = ["owner", "admin", "member", "viewer"];
const planLabel = (plan: string) => ORG_PLANS.find((p) => p.value === plan)?.label ?? plan;

/** Deterministic gradient per org id — no Math.random (SSR-safe, stable). */
const AVATAR_GRADIENTS = [
  ["#34C28E", "#1E9C74"],
  ["#5B8DEF", "#3B6FD4"],
  ["#B57BEE", "#8A4FD8"],
  ["#E8925A", "#D46E38"],
  ["#4FB3C4", "#2E8FA0"],
  ["#E5675F", "#C7463E"],
];
function orgGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const [a, b] = AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function OrgsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({});
  const [invite, setInvite] = useState({ email: "", role: "member" });
  const [inviting, setInviting] = useState(false);
  const [inviteNote, setInviteNote] = useState("");
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgPlan, setNewOrgPlan] = useState<OrgPlan>("team");
  const [creating, setCreating] = useState(false);
  const [busyDefault, setBusyDefault] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [domainDraft, setDomainDraft] = useState<Record<string, string>>({});
  const [savingDomains, setSavingDomains] = useState<string | null>(null);
  const [shared, setShared] = useState<Record<string, SharedMemory[]>>({});

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

  const refreshMembers = useCallback(async (orgId: string) => {
    const res = await adminApi.listMembers(orgId);
    setMembers((m) => ({ ...m, [orgId]: res.members ?? [] }));
  }, []);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    setCreating(true);
    try {
      await adminApi.createOrg(newOrgName.trim(), newOrgPlan);
      setNewOrgName("");
      setNewOrgPlan("team");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }

  async function saveDomains(orgId: string) {
    setSavingDomains(orgId);
    try {
      const domains = (domainDraft[orgId] ?? "").split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
      await adminApi.updateAllowedDomains(orgId, domains);
      await load();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update allowed domains");
    } finally {
      setSavingDomains(null);
    }
  }

  async function changePlan(orgId: string, plan: OrgPlan) {
    setBusyPlan(orgId);
    try {
      await adminApi.updateOrgPlan(orgId, plan);
      await load();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change plan");
    } finally {
      setBusyPlan(null);
    }
  }

  async function toggleMembers(org: OrgSummary) {
    if (expanded === org.orgId) { setExpanded(null); return; }
    setExpanded(org.orgId);
    setInvite({ email: "", role: "member" });
    if (!members[org.orgId] && org.capabilities.includes("members:manage")) {
      try { await refreshMembers(org.orgId); }
      catch (e) { setError(e instanceof Error ? e.message : "Failed to load members"); }
    }
    if (!shared[org.orgId] && org.entitlements?.features?.includes("sharedMemory")) {
      try {
        const res = await adminApi.listOrgShared(org.orgId);
        setShared((s) => ({ ...s, [org.orgId]: res.shared ?? [] }));
      } catch { /* non-fatal */ }
    }
  }

  async function inviteMember(orgId: string) {
    if (!invite.email.trim()) return;
    setInviting(true);
    setInviteNote("");
    try {
      const res = await adminApi.invite(orgId, invite.email.trim(), invite.role);
      setInvite({ email: "", role: "member" });
      setError("");
      setInviteNote(
        res.delivered
          ? `Invitation emailed to ${res.invite.email}.`
          : `Invitation created for ${res.invite.email}. Email delivery is off — share this link: ${res.link}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to invite member");
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(orgId: string, userId: string, role: string) {
    try {
      await adminApi.addMember(orgId, userId, role);
      await refreshMembers(orgId);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change role");
      await refreshMembers(orgId).catch(() => {});
    }
  }

  async function removeMember(orgId: string, userId: string) {
    try {
      await adminApi.removeMember(orgId, userId);
      await refreshMembers(orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove member");
    }
  }

  async function makeDefault(orgId: string) {
    setBusyDefault(orgId);
    try { await adminApi.setDefaultOrg(orgId); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to set default"); }
    finally { setBusyDefault(null); }
  }

  return (
    <div className="settings-page">
      <PageHeader
        title="Organizations"
        description="Create organizations, switch your default, and invite teammates by email with a role."
      />
      {error && <div className="settings-note settings-note--error">{error}</div>}

      {/* Create */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <div className="settings-cardhead"><h3>Create an organization</h3></div>
        <form onSubmit={createOrg} className="org-create">
          <label className="settings-label org-create__name">Organization name
            <input
              className="settings-input"
              placeholder="Acme Inc."
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
            />
          </label>
          <label className="settings-label org-create__plan">Plan
            <select
              className="settings-select org-planselect"
              value={newOrgPlan}
              onChange={(e) => setNewOrgPlan(e.target.value as OrgPlan)}
            >
              {ORG_PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <div className="org-create__foot">
            <PremiumButton type="submit" variant="primary" disabled={creating || !newOrgName.trim()}>
              {creating ? "Creating…" : "Create organization"}
            </PremiumButton>
            <p className="org-plan-hint">{ORG_PLANS.find((p) => p.value === newOrgPlan)?.description}</p>
          </div>
        </form>
      </PremiumCard>

      {/* List */}
      <div className="settings-stack">
        {loading ? (
          <InlineLoading label="Loading organizations…" />
        ) : orgs.length === 0 ? (
          <div className="settings-empty-inline">You don&apos;t belong to any organization yet — create one above.</div>
        ) : orgs.map((org) => {
          const canManage = org.capabilities.includes("members:manage");
          const canManageOrg = org.capabilities.includes("org:manage");
          const isOpen = expanded === org.orgId;
          const list = members[org.orgId];
          return (
            <PremiumCard key={org.orgId} level={2}>
              <div className="org-head">
                <div className="org-avatar" style={{ background: orgGradient(org.orgId) }} aria-hidden>
                  {initials(org.name)}
                </div>
                <div className="org-headmeta">
                  <h3 className="org-name">
                    {org.name}
                    <span className="settings-badge settings-badge--muted">{org.role}</span>
                    {org.isDefault && <span className="settings-badge settings-badge--default">default</span>}
                  </h3>
                  <div className="org-sub">
                    <span className="org-sub__slug">{org.slug}</span>
                    <span className="org-sub__dot">·</span>
                    {canManageOrg ? (
                      <select
                        className="settings-select org-planpick"
                        value={org.plan}
                        disabled={busyPlan === org.orgId}
                        onChange={(e) => changePlan(org.orgId, e.target.value as OrgPlan)}
                        aria-label={`Plan for ${org.name}`}
                      >
                        {ORG_PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    ) : (
                      <span>{planLabel(org.plan)} plan</span>
                    )}
                    {isOpen && list && (
                      <>
                        <span className="org-sub__dot">·</span>
                        <span>{list.length} {list.length === 1 ? "member" : "members"}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="settings-actions">
                  {/* ADR-016 — only owner/admin (triggers:manage) can connect the org's
                      GitHub App/bot; it then syncs to the desktop for signed-in members. */}
                  {org.capabilities.includes("triggers:manage") && (
                    <Link href={`/integrations/github?org=${encodeURIComponent(org.orgId)}`}>
                      <PremiumButton size="small" variant="ghost">Connect GitHub →</PremiumButton>
                    </Link>
                  )}
                  {!org.isDefault && (
                    <PremiumButton size="small" variant="ghost" disabled={busyDefault === org.orgId} onClick={() => makeDefault(org.orgId)}>
                      {busyDefault === org.orgId ? "Setting…" : "Make default"}
                    </PremiumButton>
                  )}
                  {canManage && (
                    <PremiumButton size="small" variant="text" onClick={() => toggleMembers(org)}>
                      {isOpen ? "Hide members" : "Manage members"}
                    </PremiumButton>
                  )}
                </div>
              </div>

              {isOpen && canManage && (
                <div className="org-members">
                  <div className="org-members__title">Members</div>
                  {list === undefined ? (
                    <InlineLoading label="Loading members…" />
                  ) : list.length === 0 ? (
                    <div className="settings-empty-inline">No members yet — invite someone below.</div>
                  ) : list.map((m) => (
                    <div key={m.userId} className="org-member">
                      <div className="org-member__avatar" aria-hidden>{initials(m.userId)}</div>
                      <span className="org-member__id" title={m.userId}>{m.userId}</span>
                      <select
                        className="settings-select org-rolepick"
                        value={m.role}
                        onChange={(e) => changeRole(org.orgId, m.userId, e.target.value)}
                        aria-label={`Role for ${m.userId}`}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <button
                        className="org-iconbtn"
                        title="Remove member"
                        aria-label={`Remove ${m.userId}`}
                        onClick={() => removeMember(org.orgId, m.userId)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  <div className="org-invite">
                    <label className="settings-label">Invite by email
                      <input
                        className="settings-input"
                        type="email"
                        placeholder="teammate@company.com"
                        value={invite.email}
                        onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void inviteMember(org.orgId); } }}
                      />
                    </label>
                    <label className="settings-label">Role
                      <select
                        className="settings-select"
                        value={invite.role}
                        onChange={(e) => setInvite({ ...invite, role: e.target.value })}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </label>
                    <PremiumButton variant="primary" disabled={inviting || !invite.email.trim()} onClick={() => inviteMember(org.orgId)}>
                      {inviting ? "Inviting…" : "Invite"}
                    </PremiumButton>
                  </div>
                  {inviteNote && <div className="settings-note settings-note--warn" style={{ wordBreak: "break-all" }}>{inviteNote}</div>}

                  {canManageOrg && org.entitlements?.features?.includes("domainAllowlist") && (
                    <div className="org-invite" style={{ marginTop: "var(--spacing-12)" }}>
                      <label className="settings-label" style={{ flex: "1 1 18rem" }}>Allowed email domains
                        <input
                          className="settings-input"
                          placeholder="brainrouter.dev, acme.com"
                          value={domainDraft[org.orgId] ?? (org.allowedDomains ?? []).join(", ")}
                          onChange={(e) => setDomainDraft({ ...domainDraft, [org.orgId]: e.target.value })}
                        />
                      </label>
                      <PremiumButton variant="ghost" disabled={savingDomains === org.orgId} onClick={() => saveDomains(org.orgId)}>
                        {savingDomains === org.orgId ? "Saving…" : "Save domains"}
                      </PremiumButton>
                    </div>
                  )}

                  {org.entitlements?.features?.includes("sharedMemory") && (
                    <div className="org-members" style={{ borderTop: "1px solid var(--border-dim)", marginTop: "var(--spacing-16)" }}>
                      <div className="org-members__title">Team artifacts ({(shared[org.orgId] ?? []).length})</div>
                      {shared[org.orgId] === undefined ? (
                        <InlineLoading label="Loading…" />
                      ) : (shared[org.orgId] ?? []).length === 0 ? (
                        <div className="settings-empty-inline">Nothing shared with this team yet. Members share work with <code>memory:share</code>.</div>
                      ) : (shared[org.orgId] ?? []).map((m) => (
                        <div key={m.recordId} className="org-member">
                          <span className="settings-badge settings-badge--muted">{m.type || "note"}</span>
                          <span className="org-member__id" title={m.content}>{m.content.slice(0, 120) || m.recordId}</span>
                          <span className="settings-hint">{m.userId}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </PremiumCard>
          );
        })}
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
