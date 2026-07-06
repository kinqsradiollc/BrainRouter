"use client";

/**
 * ADR-010 P4 — Organizations. See the orgs you belong to (with your role +
 * capabilities), switch your default org, and — where you have members:manage —
 * add/remove members and set roles.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { adminApi, type OrgSummary, type OrgMember } from "../../lib/adminApi";

const ROLES = ["owner", "admin", "member", "viewer"];

function OrgsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({});
  const [invite, setInvite] = useState({ userId: "", role: "member" });

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

  async function addMember(orgId: string) {
    if (!invite.userId.trim()) return;
    try {
      await adminApi.addMember(orgId, invite.userId.trim(), invite.role);
      const res = await adminApi.listMembers(orgId);
      setMembers((m) => ({ ...m, [orgId]: res.members ?? [] }));
      setInvite({ userId: "", role: "member" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add member");
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white">Organizations</h1>
      <p className="mt-1 text-sm text-neutral-400">Your organizations, roles, and members.</p>
      {error && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="mt-6 space-y-3">
        {loading ? (
          <div className="text-sm text-neutral-500">Loading…</div>
        ) : orgs.length === 0 ? (
          <div className="text-sm text-neutral-500">You don&apos;t belong to any organization yet.</div>
        ) : orgs.map((org) => (
          <div key={org.orgId} className="rounded-lg border border-neutral-800 bg-neutral-900/50">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white">{org.name}</span>
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">{org.role}</span>
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">{org.plan}</span>
                  {org.isDefault && <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-300">default</span>}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">{org.slug}</div>
              </div>
              <div className="flex items-center gap-2">
                {!org.isDefault && (
                  <button className="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-neutral-800" onClick={async () => { await adminApi.setDefaultOrg(org.orgId); await load(); }}>Make default</button>
                )}
                {org.capabilities.includes("members:manage") && (
                  <button className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800" onClick={() => openMembers(org)}>{expanded === org.orgId ? "Hide" : "Members"}</button>
                )}
              </div>
            </div>

            {expanded === org.orgId && org.capabilities.includes("members:manage") && (
              <div className="border-t border-neutral-800 px-4 py-3">
                <div className="divide-y divide-neutral-800">
                  {(members[org.orgId] ?? []).map((m) => (
                    <div key={m.userId} className="flex items-center justify-between py-2">
                      <span className="text-sm text-white">{m.userId}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-neutral-400">{m.role}</span>
                        <button className="text-xs text-red-300 hover:underline" onClick={async () => { await adminApi.removeMember(org.orgId, m.userId); const res = await adminApi.listMembers(org.orgId); setMembers((mm) => ({ ...mm, [org.orgId]: res.members ?? [] })); }}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-white" placeholder="user id to add" value={invite.userId} onChange={(e) => setInvite({ ...invite, userId: e.target.value })} />
                  <select className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-white" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500" onClick={() => addMember(org.orgId)}>Add</button>
                </div>
              </div>
            )}
          </div>
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
