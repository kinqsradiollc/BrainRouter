import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import type { TeamContext, TeamDetail, TeamKind, TeamOption, TeamRole, TeamsOps } from "./teamsOps.js";

const ROLES: readonly TeamRole[] = ["member", "admin", "owner"];
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
function initials(value: string): string { return value.replace(/@.*/, "").split(/[^a-zA-Z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?"; }

interface Props { ops: TeamsOps; onChanged(): void }

export function TeamsView({ ops, onChanged }: Props): ReactElement {
  const [contexts, setContexts] = useState<TeamContext[]>([]);
  const [orgId, setOrgId] = useState("");
  const [contextReady, setContextReady] = useState(false);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TeamKind>("organization");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void ops.contexts().then((rows) => {
      if (!active) return;
      setContexts(rows);
      setOrgId(rows.find((item) => item.isDefault)?.orgId ?? rows[0]?.orgId ?? "");
    }).catch(() => {}).finally(() => { if (active) setContextReady(true); });
    return () => { active = false; };
  }, [ops]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const rows = await ops.list(orgId || undefined);
      setTeams(rows);
      setSelectedId((current) => current && rows.some((team) => team.id === current) ? current : rows[0]?.id ?? null);
    } catch (caught) { setTeams([]); setSelectedId(null); setError(message(caught, "Could not load teams.")); }
    finally { setLoading(false); }
  }, [ops, orgId]);

  useEffect(() => { if (contextReady) void load(); }, [contextReady, load]);
  const activeContext = contexts.find((item) => item.orgId === orgId);
  const personalWorkspace = activeContext?.isPersonal === true;
  useEffect(() => { if (personalWorkspace) setKind("personal"); }, [personalWorkspace]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true; setDetailLoading(true); setError("");
    void ops.get(selectedId, orgId || undefined).then((value) => { if (active) { setDetail(value); setTeams((rows) => rows.map((team) => team.id === value.team.id ? value.team : team)); } }).catch((caught) => { if (active) setError(message(caught, "Could not load this team.")); }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [ops, orgId, selectedId]);

  const createTeam = useCallback(async (event: FormEvent) => {
    event.preventDefault(); const value = name.trim(); if (!value || busy) return;
    setBusy("create"); setError("");
    try { const created = await ops.create(value, kind, orgId || undefined); setName(""); await load(); setSelectedId(created.id); onChanged(); }
    catch (caught) { setError(message(caught, "Could not create the team.")); }
    finally { setBusy(""); }
  }, [busy, kind, load, name, onChanged, ops, orgId]);

  const addMember = useCallback(async (event: FormEvent) => {
    event.preventDefault(); const value = account.trim(); if (!detail || !value || busy) return;
    setBusy("add-member"); setError("");
    try { const members = await ops.addMember(detail.team.id, value, role, orgId || undefined); setDetail((current) => current ? { ...current, members } : current); setAccount(""); onChanged(); }
    catch (caught) { setError(message(caught, "Could not add that member.")); }
    finally { setBusy(""); }
  }, [account, busy, detail, onChanged, ops, orgId, role]);

  const removeMember = useCallback(async (memberUserId: string) => {
    if (!detail || busy || globalThis.confirm?.(`Remove ${memberUserId} from ${detail.team.name}?`) === false) return;
    setBusy(`member:${memberUserId}`); setError(""); const previous = detail.members;
    setDetail({ ...detail, members: previous.filter((member) => member.userId !== memberUserId) });
    try {
      await ops.removeMember(detail.team.id, memberUserId, orgId || undefined);
      if (memberUserId === detail.currentUserId) await load();
      onChanged();
    }
    catch (caught) { setDetail((current) => current ? { ...current, members: previous } : current); setError(message(caught, "Could not remove that member.")); }
    finally { setBusy(""); }
  }, [busy, detail, load, onChanged, ops, orgId]);

  const removeTeam = useCallback(async () => {
    if (!detail || busy || globalThis.confirm?.(`Delete ${detail.team.name}? Team-only meeting access will be revoked immediately.`) === false) return;
    setBusy("delete-team"); setError("");
    try { await ops.remove(detail.team.id, orgId || undefined); setDetail(null); setSelectedId(null); await load(); onChanged(); }
    catch (caught) { setError(message(caught, "Could not delete the team.")); }
    finally { setBusy(""); }
  }, [busy, detail, load, onChanged, ops, orgId]);

  const personal = useMemo(() => teams.filter((team) => team.kind === "personal"), [teams]);
  const organization = useMemo(() => teams.filter((team) => team.kind === "organization"), [teams]);
  const memberCount = detail?.members.length ?? 0;
  const ownerCount = detail?.members.filter((member) => member.role === "owner").length ?? 0;
  const teamButton = (team: TeamOption) => <button type="button" key={team.id} className={`tmv-team${selectedId === team.id ? " tmv-team-on" : ""}`} onClick={() => setSelectedId(team.id)} aria-pressed={selectedId === team.id}><span className={`tmv-team-mark${team.kind === "personal" ? " tmv-team-personal" : ""}`}>{initials(team.name)}</span><span><b>{team.name}</b><small>{team.kind === "personal" ? "Personal · cross-org" : team.orgName ?? "Organization"}{team.myRole ? ` · ${team.myRole}` : ""}</small></span><span aria-hidden="true">›</span></button>;

  return <div className="tmv">
    <header className="tmv-head"><div><span className="mv-eyebrow">Collaboration</span><h2>Teams</h2><p>Organization groups and personal circles with explicit meeting access.</p></div>{contexts.length ? <label className="tmv-context">Organization context<select value={orgId} onChange={(event) => setOrgId(event.target.value)}>{contexts.map((item) => <option key={item.orgId} value={item.orgId}>{item.name}</option>)}</select></label> : null}</header>
    <form className="tmv-create tmv-create-space" onSubmit={(event) => void createTeam(event)}><div className="tmv-kind" role="group" aria-label="New team kind"><button type="button" className={kind === "organization" ? "tmv-kind-on" : ""} onClick={() => setKind("organization")} disabled={personalWorkspace} title={personalWorkspace ? "Select a shared organization to create an organization team." : undefined}>Organization</button><button type="button" className={kind === "personal" ? "tmv-kind-on" : ""} onClick={() => setKind("personal")}>Personal</button></div><span>{personalWorkspace ? "Personal workspace · explicit access only." : kind === "personal" ? "Any registered user; no organization access." : "Existing organization members only."}</span><label className="mv-sr-only" htmlFor="tmv-name">Team name</label><input id="tmv-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New team name" maxLength={200} /><button className="mv-primary" disabled={!name.trim() || busy === "create"}>{busy === "create" ? "Creating…" : "Create team"}</button></form>
    {error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
    <div className="tmv-layout"><nav className="tmv-list" aria-label="Teams"><div className="tmv-list-head"><span>Your teams</span><span>{teams.length}</span></div>{loading ? <div className="mv-state">Loading teams…</div> : !teams.length ? <div className="mv-state">No teams yet. Choose the collaboration boundary above.</div> : <>{personal.length ? <><div className="tmv-group">Personal teams</div>{personal.map(teamButton)}</> : null}{organization.length ? <><div className="tmv-group">Organization teams</div>{organization.map(teamButton)}</> : null}</>}</nav>
      <section className="tmv-detail" aria-live="polite">{detailLoading ? <div className="mv-state">Loading team members…</div> : detail ? <><div className="tmv-title-row"><div><span className={`tmv-kind-pill${detail.team.kind === "personal" ? " tmv-kind-personal" : ""}`}>{detail.team.kind === "personal" ? "Personal team" : "Organization team"}</span><h3>{detail.team.name}</h3><p>{detail.team.kind === "personal" ? "Explicit access across organizations" : detail.team.orgName ?? "Current organization"} · {memberCount} {memberCount === 1 ? "member" : "members"}</p></div>{detail.team.canManage ? <button type="button" className="mv-danger-btn" onClick={() => void removeTeam()} disabled={busy === "delete-team"}>{busy === "delete-team" ? "Deleting…" : "Delete team"}</button> : null}</div><div className="tmv-boundary">{detail.team.kind === "personal" ? "Joining this team never grants organization membership. Members receive only explicitly shared resources." : "Only members of this organization are eligible. Organization admins can manage this team."}</div>{detail.team.canManage ? <form className="tmv-add" onSubmit={(event) => void addMember(event)}><div><label htmlFor="tmv-user">Email or user ID</label><input id="tmv-user" value={account} onChange={(event) => setAccount(event.target.value)} placeholder="person@example.com or usr_…" /></div><div><label htmlFor="tmv-role">Role</label><select id="tmv-role" value={role} onChange={(event) => setRole(event.target.value as TeamRole)}>{ROLES.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></div><button className="mv-primary" disabled={!account.trim() || busy === "add-member"}>{busy === "add-member" ? "Saving…" : "Save member"}</button></form> : null}<div className="tmv-members"><div className="tmv-members-head"><span>Members</span><span>Role</span><span>Actions</span></div>{detail.members.map((member) => { const label = member.displayName || member.email || member.userId; const isSelf = member.userId === detail.currentUserId; const canRemove = detail.team.canManage || isSelf; const isLastOwner = member.role === "owner" && ownerCount === 1; return <div className="tmv-member" key={member.userId}><span className="tmv-avatar">{initials(label)}</span><span className="tmv-member-id"><b>{label}{isSelf ? " (you)" : ""}</b><small>{member.displayName && member.email ? member.email : member.userId}</small></span><span className={`tmv-role tmv-role-${member.role}`}>{member.role}</span>{canRemove ? <button type="button" onClick={() => void removeMember(member.userId)} disabled={busy === `member:${member.userId}` || isLastOwner} title={isLastOwner ? "Promote another owner before removing the last owner." : undefined}>{busy === `member:${member.userId}` ? (isSelf ? "Leaving…" : "Removing…") : (isSelf ? "Leave" : "Remove")}</button> : <span />}</div>; })}</div></> : <div className="mv-state">Select a team to manage its members.</div>}</section>
    </div>
  </div>;
}
