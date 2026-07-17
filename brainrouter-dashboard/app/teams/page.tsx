"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Buildings, Plus, Trash, UserCircle, UserPlus, UsersThree } from "@phosphor-icons/react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { adminApi, type OrgSummary, type Team, type TeamKind, type TeamMember } from "../../lib/adminApi";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import styles from "./teams.module.css";

const ROLES = ["member", "admin", "owner"] as const;

function initials(value: string): string {
  return value.replace(/@.*/, "").split(/[^a-zA-Z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function TeamsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgId, setOrgId] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamKind, setNewTeamKind] = useState<TeamKind>("organization");
  const [newMember, setNewMember] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<string>("member");

  useEffect(() => {
    let active = true;
    void adminApi.listOrgs().then(({ orgs: rows }) => {
      if (!active) return;
      setOrgs(rows);
      setOrgId((current) => current || rows.find((org) => org.isDefault)?.orgId || rows[0]?.orgId || "");
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load organizations."); });
    return () => { active = false; };
  }, []);

  // Defense in depth: never send an org the caller wasn't shown. A tampered
  // orgId state that isn't in the loaded org list is rejected before it reaches
  // the org-scoped admin API (the server also 403s a non-member org).
  const orgAllowed = useMemo(() => !orgId || orgs.some((org) => org.orgId === orgId), [orgId, orgs]);

  const load = useCallback(async () => {
    if (!orgId || !orgAllowed) return;
    setLoading(true);
    try {
      const result = await queryDashboard(`teams:list:${orgId}`, () => adminApi.listTeams(orgId), { ttlMs: 30_000 });
      const list = result.teams ?? [];
      setTeams(list);
      setSelectedId((current) => current && list.some((team) => team.id === current) ? current : list[0]?.id ?? null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load teams.");
      setTeams([]);
    } finally { setLoading(false); }
  }, [orgAllowed, orgId]);

  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    if (!orgId || !orgAllowed) return;
    setDetailLoading(true);
    try {
      const result = await queryDashboard(`teams:detail:${orgId}:${id}`, () => adminApi.getTeam(id, orgId), { ttlMs: 30_000 });
      setMembers(result.members ?? []);
      setCurrentUserId(result.currentUserId ?? "");
      setTeams((current) => current.map((team) => team.id === id ? { ...team, ...result.team } : team));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load team members.");
      setMembers([]);
      setCurrentUserId("");
    } finally { setDetailLoading(false); }
  }, [orgAllowed, orgId]);

  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setMembers([]); }, [selectedId, loadDetail]);

  const createTeam = useCallback(async () => {
    const name = newTeamName.trim();
    if (!name || !orgId || !orgAllowed) return;
    setBusy("create");
    try {
      const { team } = await adminApi.createTeam(name, newTeamKind, orgId);
      invalidateDashboardQueries("teams:");
      setNewTeamName("");
      await load();
      setSelectedId(team.id);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the team."); }
    finally { setBusy(""); }
  }, [load, newTeamKind, newTeamName, orgAllowed, orgId]);

  const addMember = useCallback(async () => {
    const account = newMember.trim();
    if (!account || !selectedId || !orgId || !orgAllowed) return;
    setBusy("add-member");
    try {
      const result = await adminApi.addTeamMember(selectedId, account, newMemberRole, orgId);
      invalidateDashboardQueries(`teams:detail:${orgId}:${selectedId}`);
      setMembers(result.members ?? []);
      setNewMember("");
      setNewMemberRole("member");
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add the member."); }
    finally { setBusy(""); }
  }, [newMember, newMemberRole, orgAllowed, orgId, selectedId]);

  const removeMember = useCallback(async (userId: string) => {
    if (!selectedId || !orgId || !orgAllowed || !window.confirm(`Remove ${userId} from this team?`)) return;
    setBusy(`remove:${userId}`);
    try {
      await adminApi.removeTeamMember(selectedId, userId, orgId);
      invalidateDashboardQueries(`teams:detail:${orgId}:${selectedId}`);
      setMembers((current) => current.filter((member) => member.userId !== userId));
      if (userId === currentUserId) {
        invalidateDashboardQueries(`teams:list:${orgId}`);
        await load();
      }
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not remove the member."); }
    finally { setBusy(""); }
  }, [currentUserId, load, orgAllowed, orgId, selectedId]);

  const deleteTeam = useCallback(async (id: string) => {
    if (!orgId || !orgAllowed || !window.confirm("Delete this team? Team-only meeting access will be revoked immediately.")) return;
    setBusy("delete");
    try {
      await adminApi.deleteTeam(id, orgId);
      invalidateDashboardQueries("teams:");
      await load();
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not delete the team."); }
    finally { setBusy(""); }
  }, [load, orgAllowed, orgId]);

  const selected = teams.find((team) => team.id === selectedId) ?? null;
  const selectedOrg = orgs.find((org) => org.orgId === orgId);
  const personalWorkspace = selectedOrg?.isPersonal === true;
  const ownerCount = members.filter((member) => member.role === "owner").length;
  useEffect(() => { if (personalWorkspace) setNewTeamKind("personal"); }, [personalWorkspace]);
  const personalTeams = useMemo(() => teams.filter((team) => team.kind === "personal"), [teams]);
  const organizationTeams = useMemo(() => teams.filter((team) => team.kind === "organization"), [teams]);

  const renderTeam = (team: Team) => (
    <button type="button" key={team.id} className={`${styles.item}${team.id === selectedId ? ` ${styles.itemOn}` : ""}`} onClick={() => setSelectedId(team.id)} aria-pressed={team.id === selectedId}>
      <span className={styles.teamIcon}>{team.kind === "personal" ? <UserCircle size={17} weight="duotone" /> : <UsersThree size={16} weight="duotone" />}</span>
      <span className={styles.itemCopy}><span className={styles.itemT}>{team.name}</span><span className={styles.itemM}>{team.kind === "personal" ? "Across organizations" : team.orgName ?? "Organization"}{team.myRole ? ` · ${team.myRole}` : ""}</span></span>
      <span className={styles.chevron}>›</span>
    </button>
  );

  return <>
    <PageHeader title="Teams" description="Organization groups and personal collaboration circles, with explicit meeting and memory access.">
      <label className={styles.orgPicker}>Organization context<select value={orgId} onChange={(event) => setOrgId(event.target.value)}>{orgs.map((org) => <option key={org.orgId} value={org.orgId}>{org.name}</option>)}</select></label>
    </PageHeader>
    <div className={styles.page}>
      {error ? <div className={styles.errorBar} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
      <div className={styles.wrap}>
        <section className={styles.list} aria-label="Your teams">
          <div className={styles.listHead}><div><span className={styles.eyebrow}>Collaboration</span><h2>Your teams</h2></div><span className={styles.count}>{teams.length}</span></div>
          <div className={styles.createBox}>
            <div className={styles.kindSwitch} role="group" aria-label="New team kind">
              <button type="button" className={newTeamKind === "organization" ? styles.kindOn : ""} onClick={() => setNewTeamKind("organization")} disabled={personalWorkspace} title={personalWorkspace ? "Select a shared organization to create an organization team." : undefined}><Buildings size={13} />Organization</button>
              <button type="button" className={newTeamKind === "personal" ? styles.kindOn : ""} onClick={() => setNewTeamKind("personal")}><UserCircle size={13} />Personal</button>
            </div>
            <p>{personalWorkspace ? "Personal workspaces create personal teams. Select a shared organization for an organization-bound team." : newTeamKind === "personal" ? "Invite any registered user. Membership never grants organization access." : "Members must already belong to the selected organization."}</p>
            <div className={styles.createRow}><input value={newTeamName} onChange={(event) => setNewTeamName(event.target.value)} placeholder={newTeamKind === "personal" ? "e.g. Research circle" : "e.g. Platform"} aria-label="New team name" onKeyDown={(event) => { if (event.key === "Enter") void createTeam(); }} /><button type="button" onClick={() => void createTeam()} disabled={busy === "create" || !newTeamName.trim()}><Plus size={14} weight="bold" />{busy === "create" ? "Creating…" : "Create"}</button></div>
          </div>
          <div className={styles.teamRows}>
            {personalTeams.length ? <><div className={styles.groupLabel}>Personal teams <span>{personalTeams.length}</span></div>{personalTeams.map(renderTeam)}</> : null}
            {organizationTeams.length ? <><div className={styles.groupLabel}>Organization teams <span>{organizationTeams.length}</span></div>{organizationTeams.map(renderTeam)}</> : null}
            {!teams.length ? <div className={styles.empty}>{loading ? <InlineLoading label="Loading teams…" /> : <><span className={styles.emptyIcon}><UsersThree size={24} /></span><strong>No teams yet</strong><span>Create an organization group or a personal cross-organization circle.</span></>}</div> : null}
          </div>
        </section>

        {selected ? <div className={styles.detail}>
          <div className={styles.dHead}><div><div className={styles.titleMeta}><span className={`${styles.kindPill} ${selected.kind === "personal" ? styles.personalPill : ""}`}>{selected.kind === "personal" ? "Personal team" : "Organization team"}</span>{selected.myRole ? <span className={styles.roleBadge}>{selected.myRole}</span> : null}</div><h3>{selected.name}</h3><div className={styles.sub}>{selected.kind === "personal" ? "Independent of organization membership" : selected.orgName ?? "Current organization"} · {members.length} {members.length === 1 ? "member" : "members"}</div></div>{selected.canManage ? <button type="button" className={styles.danger} onClick={() => void deleteTeam(selected.id)} disabled={busy === "delete"}><Trash size={14} />{busy === "delete" ? "Deleting…" : "Delete team"}</button> : null}</div>
          <div className={styles.boundary}><strong>{selected.kind === "personal" ? "Explicit access only" : "Organization boundary"}</strong><span>{selected.kind === "personal" ? "People from different organizations can join, but they receive only resources shared to this team." : "Only existing members of this organization can be added. Organization admins can manage this team."}</span></div>
          {selected.canManage ? <div className={styles.card}><div className={styles.cardHead}><span className={styles.cardIcon}><UserPlus size={16} /></span><div><div className={styles.cardLab}>Add or update member</div><p>Enter a registered account email or BrainRouter user ID. Existing members receive the selected role.</p></div></div><div className={styles.addRow}><input value={newMember} onChange={(event) => setNewMember(event.target.value)} placeholder="Email or user ID" aria-label="Email or user ID to add or update" onKeyDown={(event) => { if (event.key === "Enter") void addMember(); }} /><select value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value)} aria-label="Member role">{ROLES.map((role) => <option key={role} value={role}>{role[0]?.toUpperCase()}{role.slice(1)}</option>)}</select><button type="button" onClick={() => void addMember()} disabled={busy === "add-member" || !newMember.trim()}>{busy === "add-member" ? "Saving…" : "Save member"}</button></div></div> : <div className={styles.boundary}><strong>Read-only membership</strong><span>An owner or admin manages this team.</span></div>}
          <div className={styles.card}><div className={styles.cardHead}><span className={styles.cardIcon}><UsersThree size={16} /></span><div><div className={styles.cardLab}>Members</div><p>Removing someone revokes team-derived access immediately.</p></div></div>{detailLoading ? <div className={styles.empty}><InlineLoading label="Loading members…" /></div> : members.map((member) => { const label = member.displayName || member.email || member.userId; const isSelf = member.userId === currentUserId; const isLastOwner = member.role === "owner" && ownerCount === 1; return <div key={member.userId} className={styles.member}><div className={styles.memberMeta}><span className={styles.avatar}>{initials(label)}</span><span className={styles.memberCopy}><strong>{label}{isSelf ? " (you)" : ""}</strong><small>{member.displayName && member.email ? member.email : member.userId}</small></span><span className={styles.roleBadge}>{member.role}</span></div>{selected.canManage || isSelf ? <button type="button" className={styles.linkDanger} onClick={() => void removeMember(member.userId)} disabled={busy === `remove:${member.userId}` || isLastOwner} title={isLastOwner ? "Promote another owner before removing the last owner." : undefined}>{busy === `remove:${member.userId}` ? (isSelf ? "Leaving…" : "Removing…") : (isSelf ? "Leave" : "Remove")}</button> : null}</div>; })}</div>
        </div> : <div className={`${styles.detail} ${styles.detailEmpty}`}><div className={styles.empty}>{loading ? <InlineLoading label="Loading teams…" /> : <><span className={styles.emptyIcon}><UsersThree size={28} /></span><strong>Create your first team</strong><span>Choose the boundary that matches how these people work together.</span></>}</div></div>}
      </div>
    </div>
  </>;
}

export default function TeamsPage() { return <AuthGuard><TeamsInner /></AuthGuard>; }
