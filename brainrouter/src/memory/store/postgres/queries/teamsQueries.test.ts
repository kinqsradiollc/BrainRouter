import { describe, expect, it, vi } from "vitest";
import {
  createTeam, listTeamsForUser, getTeam, isTeamMember, listTeamMembers, insertTeamOwner,
  addTeamMember, removeTeamMember, transferPersonalTeamOwnership, deleteTeam,
} from "./teamsQueries.js";

const teamRow = {
  id: "team_1", kind: "organization", org_id: "org-1", org_name: "Acme", owner_user_id: null, name: "Platform", created_by: "user-1",
  created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
};
const memberRow = { team_id: "team_1", user_id: "user-1", role: "owner", display_name: "User One", email: "one@example.test", created_at: "2026-07-16T00:00:00.000Z" };

function executor(row: Record<string, unknown> | null = teamRow, rows: Record<string, unknown>[] = [teamRow], runCount = 1) {
  return {
    one: vi.fn(async () => row),
    rows: vi.fn(async () => rows),
    run: vi.fn(async () => runCount),
    tx: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rowCount: 1 })) })),
  } as any;
}

describe("teams queries — tenancy + org-scoping", () => {
  it("creates a team returning the mapped row", async () => {
    const exec = executor();
    const team = await createTeam(exec, { id: "team_1", kind: "organization", orgId: "org-1", ownerUserId: null, name: "Platform", createdBy: "user-1" });
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO teams");
    expect(params).toEqual(["team_1", "organization", "org-1", null, "Platform", "user-1"]);
    expect(team).toMatchObject({ id: "team_1", kind: "organization", orgId: "org-1", orgName: "Acme", name: "Platform", createdBy: "user-1" });
  });

  it("lists personal memberships plus organization teams in active context", async () => {
    const exec = executor();
    await listTeamsForUser(exec, "org-1", "user-1");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("LEFT JOIN team_members mine ON mine.team_id = t.id AND mine.user_id = $2");
    expect(sql).toContain("t.kind = 'personal'");
    expect(sql).toContain("t.kind = 'organization' AND t.org_id = $1");
    expect(params).toEqual(["org-1", "user-1", false]);
  });

  it("getTeam resolves same-org organization teams or personal teams", async () => {
    const exec = executor();
    await getTeam(exec, "org-1", "team_1");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("t.kind = 'organization' AND t.org_id = $1");
    expect(sql).toContain("OR t.kind = 'personal'");
    expect(params).toEqual(["org-1", "team_1"]);
  });

  it("isTeamMember joins the team to enforce org scope; true when a row is found", async () => {
    const exec = executor({ ok: 1 });
    const ok = await isTeamMember(exec, "org-1", "team_1", "user-1");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("JOIN team_members m ON m.team_id = t.id");
    expect(sql).toContain("t.id = $2 AND m.user_id = $3");
    expect(sql).toContain("t.kind = 'personal'");
    expect(params).toEqual(["org-1", "team_1", "user-1"]);
    expect(ok).toBe(true);
  });

  it("isTeamMember is false when no row (wrong org, or not a member)", async () => {
    const exec = executor(null);
    await expect(isTeamMember(exec, "org-2", "team_1", "user-1")).resolves.toBe(false);
  });

  it("listTeamMembers is org-scoped via a join and requires the caller to be a team member", async () => {
    const exec = executor(teamRow, [memberRow]);
    const members = await listTeamMembers(exec, "org-1", "team_1", "user-1");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("JOIN teams t ON t.id = m.team_id");
    expect(sql).toContain("WHERE m.team_id = $2");
    expect(sql).toContain("t.kind = 'organization' AND t.org_id = $1");
    // Caller must be a member (EXISTS on team_members) unless an org admin can view all org teams.
    expect(sql).toContain("$4 OR EXISTS");
    expect(sql).toContain("cm.user_id = $3");
    expect(params).toEqual(["org-1", "team_1", "user-1", false]);
    expect(members[0]).toMatchObject({ teamId: "team_1", userId: "user-1", role: "owner" });
  });

  it("listTeamMembers lets an org admin bypass the caller-membership gate", async () => {
    const exec = executor(teamRow, [memberRow]);
    await listTeamMembers(exec, "org-1", "team_1", "admin-x", true);
    const [, params] = exec.rows.mock.calls[0]!;
    expect(params).toEqual(["org-1", "team_1", "admin-x", true]);
  });

  it("insertTeamOwner bootstraps the creator as owner without a caller check", async () => {
    const exec = executor();
    await expect(insertTeamOwner(exec, "team_1", "user-1")).resolves.toBe(true);
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO team_members");
    expect(sql).toContain("'owner'");
    expect(sql).not.toContain("cm.role IN");
    expect(params).toEqual(["team_1", "user-1"]);
  });

  it("addTeamMember checks active account, org membership, and caller owner/admin authority in SQL", async () => {
    const exec = executor();
    await addTeamMember(exec, "org-1", "team_1", "user-2", "admin", "owner-1");
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("LEFT JOIN org_members om");
    expect(sql).toContain("t.kind = 'personal'");
    expect(sql).toContain("t.kind = 'organization' AND t.org_id = $1 AND om.user_id IS NOT NULL");
    // Caller must be a team owner/admin (or an org admin managing an org team).
    expect(sql).toContain("cm.user_id = $5 AND cm.role IN ('owner', 'admin')");
    expect(sql).toContain("$6 AND t.kind = 'organization'");
    expect(sql).toContain("ON CONFLICT (team_id, user_id) DO UPDATE");
    expect(params).toEqual(["org-1", "team_1", "user-2", "admin", "owner-1", false]);
  });

  it("addTeamMember returns false when the team is not in the org", async () => {
    const exec = executor(teamRow, [teamRow], 0);
    await expect(addTeamMember(exec, "org-2", "team_1", "user-2", "member", "owner-1")).resolves.toBe(false);
  });

  it("addTeamMember passes the org-admin override flag through", async () => {
    const exec = executor();
    await addTeamMember(exec, "org-1", "team_1", "user-2", "member", "admin-1", true);
    const [, params] = exec.run.mock.calls[0]!;
    expect(params).toEqual(["org-1", "team_1", "user-2", "member", "admin-1", true]);
  });

  it("removeTeamMember is scoped to teams in the org and gated to owner/admin or self-leave", async () => {
    const exec = executor();
    await removeTeamMember(exec, "org-1", "team_1", "user-2", "owner-1");
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("kind = 'organization' AND org_id = $1");
    expect(sql).toContain("OR kind = 'personal'");
    // Self-leave ($4 = $3) or a team owner/admin (or org admin) may remove.
    expect(sql).toContain("$4 = $3");
    expect(sql).toContain("cm.user_id = $4 AND cm.role IN ('owner', 'admin')");
    expect(params).toEqual(["org-1", "team_1", "user-2", "owner-1", false]);
  });

  it("transfers a personal team's lifecycle owner only to an existing owner", async () => {
    const exec = executor();
    await expect(transferPersonalTeamOwnership(exec, "team_1", "user-1", "user-2")).resolves.toBe(true);
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("t.kind = 'personal'");
    expect(sql).toContain("m.role = 'owner'");
    expect(params).toEqual(["team_1", "user-1", "user-2"]);
  });

  it("deleteTeam removes the org-scoped team then its members, in a tx", async () => {
    const query = vi.fn(async (_text: string, _params?: unknown[]) => ({ rowCount: 1 }));
    const exec = {
      one: vi.fn(), rows: vi.fn(), run: vi.fn(),
      tx: vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query })),
    } as any;
    const ok = await deleteTeam(exec, "org-1", "team_1");
    expect(exec.tx).toHaveBeenCalled();
    expect(ok).toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain("UPDATE meetings SET scope = 'private'");
    expect(query.mock.calls[1]?.[0]).toContain("UPDATE cognitive_records SET visibility = 'private'");
  });

  it("deleteTeam returns false when the team is not in the org", async () => {
    const exec = {
      one: vi.fn(), rows: vi.fn(), run: vi.fn(),
      tx: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rowCount: 0 })) })),
    } as any;
    await expect(deleteTeam(exec, "org-2", "team_1")).resolves.toBe(false);
  });
});
