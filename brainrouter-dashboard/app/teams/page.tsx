"use client";

/**
 * Teams — sub-groups inside the active org used for scoped sharing (e.g. a
 * meeting shared with scope==='team'). List the teams you belong to, create a
 * team (you become its owner), and open a team to add / remove members or delete
 * it. Real, org-scoped data from the backend at /api/teams using the signed-in
 * account's JWT — the same active org Meetings and Projects use. No sample data.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { adminApi, type Team, type TeamMember } from "../../lib/adminApi";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import styles from "./teams.module.css";

const ROLES = ["member", "admin", "owner"] as const;

function TeamsInner() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<string>("member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await queryDashboard("teams:list", () => adminApi.listTeams(), { ttlMs: 30_000 });
      const list = r.teams ?? [];
      setTeams(list);
      setSelectedId((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id ?? null));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load teams.");
      setTeams([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await queryDashboard(`teams:detail:${id}`, () => adminApi.getTeam(id), { ttlMs: 30_000 });
      setMembers(r.members ?? []);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load team members.");
      setMembers([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setMembers([]); return; }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const createTeam = useCallback(async () => {
    const name = newTeamName.trim();
    if (!name) return;
    setBusy("create");
    try {
      const { team } = await adminApi.createTeam(name);
      invalidateDashboardQueries("teams:");
      setTeams((cur) => [...cur, team]);
      setNewTeamName("");
      setSelectedId(team.id);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the team.");
    } finally {
      setBusy("");
    }
  }, [newTeamName]);

  const addMember = useCallback(async () => {
    const userId = newMemberId.trim();
    if (!userId || !selectedId) return;
    setBusy("add-member");
    try {
      await adminApi.addTeamMember(selectedId, userId, newMemberRole);
      invalidateDashboardQueries(`teams:detail:${selectedId}`);
      setNewMemberId("");
      setNewMemberRole("member");
      await loadDetail(selectedId);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the member.");
    } finally {
      setBusy("");
    }
  }, [newMemberId, newMemberRole, selectedId, loadDetail]);

  const removeMember = useCallback(async (userId: string) => {
    if (!selectedId) return;
    if (!window.confirm(`Remove ${userId} from this team?`)) return;
    setBusy(`remove:${userId}`);
    try {
      await adminApi.removeTeamMember(selectedId, userId);
      invalidateDashboardQueries(`teams:detail:${selectedId}`);
      setMembers((cur) => cur.filter((m) => m.userId !== userId));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the member.");
    } finally {
      setBusy("");
    }
  }, [selectedId]);

  const deleteTeam = useCallback(async (id: string) => {
    if (!window.confirm("Delete this team? This can't be undone. (Only a team owner or an org admin can.)")) return;
    setBusy("delete");
    try {
      await adminApi.deleteTeam(id);
      invalidateDashboardQueries("teams:");
      setTeams((cur) => cur.filter((t) => t.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the team.");
    } finally {
      setBusy("");
    }
  }, []);

  const selected = teams.find((t) => t.id === selectedId) ?? null;

  return (
    <>
      <PageHeader title="Teams" description="Sub-groups inside your organization for scoped sharing — add teammates, then share meetings and memory with a team." />
      <div className={styles.page}>
        {error ? <div className={styles.errorBar} role="alert">{error}</div> : null}
        <div className={styles.wrap}>
          <div className={styles.list}>
            <div className={styles.listHead}><h2>Your teams</h2></div>
            <div className={styles.createRow}>
              <input
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="New team name"
                aria-label="New team name"
                onKeyDown={(e) => { if (e.key === "Enter") void createTeam(); }}
              />
              <button type="button" onClick={() => void createTeam()} disabled={busy === "create" || !newTeamName.trim()}>
                {busy === "create" ? "Creating…" : "Create"}
              </button>
            </div>
            {teams.map((t) => (
              <div
                key={t.id}
                className={`${styles.item}${t.id === selectedId ? ` ${styles.itemOn}` : ""}`}
                onClick={() => setSelectedId(t.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(t.id); }}
              >
                <div className={styles.itemT}>{t.name}</div>
                <div className={styles.itemM}>Created {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</div>
              </div>
            ))}
            {teams.length === 0 ? (
              <div className={styles.empty}>{loading ? <InlineLoading /> : "No teams yet. Name one above to create it."}</div>
            ) : null}
          </div>

          {selected ? (
            <div className={styles.detail}>
              <div className={styles.dHead}>
                <div>
                  <h3>{selected.name}</h3>
                  <div className={styles.sub}>{members.length} {members.length === 1 ? "member" : "members"}</div>
                </div>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => void deleteTeam(selected.id)}
                  disabled={busy === "delete"}
                >
                  {busy === "delete" ? "Deleting…" : "Delete team"}
                </button>
              </div>

              <div className={styles.card}>
                <div className={styles.cardLab}>Add member</div>
                <div className={styles.addRow}>
                  <input
                    value={newMemberId}
                    onChange={(e) => setNewMemberId(e.target.value)}
                    placeholder="User ID"
                    aria-label="User ID to add"
                    onKeyDown={(e) => { if (e.key === "Enter") void addMember(); }}
                  />
                  <select value={newMemberRole} onChange={(e) => setNewMemberRole(e.target.value)} aria-label="Member role">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button type="button" onClick={() => void addMember()} disabled={busy === "add-member" || !newMemberId.trim()}>
                    {busy === "add-member" ? "Adding…" : "Add"}
                  </button>
                </div>
              </div>

              <div className={styles.card}>
                <div className={styles.cardLab}>Members</div>
                {detailLoading ? (
                  <div className={styles.empty}><InlineLoading label="Loading members…" /></div>
                ) : members.length === 0 ? (
                  <div className={styles.empty}>No members yet. Add a teammate by user ID above.</div>
                ) : (
                  members.map((m) => (
                    <div key={m.userId} className={styles.member}>
                      <div className={styles.memberMeta}>
                        <span className={styles.memberId}>{m.userId}</span>
                        <span className={styles.roleBadge}>{m.role}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.linkDanger}
                        onClick={() => void removeMember(m.userId)}
                        disabled={busy === `remove:${m.userId}`}
                      >
                        {busy === `remove:${m.userId}` ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className={styles.detail}>
              <div className={styles.empty}>{loading ? <InlineLoading /> : teams.length ? "Select a team." : "Create your first team to get started."}</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function TeamsPage() {
  return (
    <AuthGuard>
      <TeamsInner />
    </AuthGuard>
  );
}
