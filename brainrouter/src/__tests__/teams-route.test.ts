import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  listTeamsForUser: vi.fn(),
  getTeam: vi.fn(),
  isTeamMember: vi.fn(),
  listTeamMembers: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  deleteTeam: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" }
        : key === "br_dev" ? { userId: "user-2", isAdmin: false, email: "dev@example.test" } : null),
    getUserById: mocks.getUserById,
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    store: {
      createTeam: mocks.createTeam,
      listTeamsForUser: mocks.listTeamsForUser,
      getTeam: mocks.getTeam,
      isTeamMember: mocks.isTeamMember,
      listTeamMembers: mocks.listTeamMembers,
      addTeamMember: mocks.addTeamMember,
      removeTeamMember: mocks.removeTeamMember,
      deleteTeam: mocks.deleteTeam,
    },
  },
}));

import { teamsRouter } from "../api/routes/teams.js";

function team(id = "team_1", orgId = "org-a") {
  return { id, orgId, name: "Platform", createdBy: "user-1", createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" };
}

describe("teams route — org isolation + management gating", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    // user-1 is an org admin of org-a; user-2 is a plain developer of org-a.
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId !== "org-a") return null;
      return userId === "user-1" ? "admin" : userId === "user-2" ? "developer" : null;
    });
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });
    mocks.listTeamsForUser.mockResolvedValue([team()]);
    mocks.getTeam.mockResolvedValue(team());
    mocks.isTeamMember.mockResolvedValue(true);
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_1", userId: "user-1", role: "owner", createdAt: "t" }]);
    mocks.createTeam.mockImplementation(async (input: Record<string, unknown>) => team(String(input.id), String(input.orgId)));
    mocks.addTeamMember.mockResolvedValue(true);
    mocks.removeTeamMember.mockResolvedValue(true);
    mocks.deleteTeam.mockResolvedValue(true);

    const app = express();
    app.use(express.json());
    app.use("/api/teams", teamsRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

  const headers = (key = "br_user", orgId = "org-a") => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-BrainRouter-Org": orgId });

  it("lists the caller's teams in the active org", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).teams).toHaveLength(1);
    expect(mocks.listTeamsForUser).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("creates a team scoped to the caller's org", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Platform" }) });
    expect(res.status).toBe(201);
    expect(mocks.createTeam.mock.calls[0]![0].orgId).toBe("org-a");
    // creator auto-added as owner member
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", expect.any(String), "user-1", "owner");
  });

  it("rejects an empty team name with 400", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "  " }) });
    expect(res.status).toBe(400);
    expect(mocks.createTeam).not.toHaveBeenCalled();
  });

  it("returns a team + members for a member", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team.id).toBe("team_1");
    expect(body.members).toHaveLength(1);
  });

  it("hides a team (404) from a non-member, non-admin caller", async () => {
    mocks.isTeamMember.mockResolvedValue(false);
    const res = await fetch(`${baseUrl}/api/teams/team_1`, { headers: headers("br_dev") });
    expect(res.status).toBe(404);
  });

  it("lets an org admin add a member", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers(), body: JSON.stringify({ userId: "user-3", role: "member" }) });
    expect(res.status).toBe(200);
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3", "member");
  });

  it("forbids a plain developer (not a team owner/admin) from adding a member", async () => {
    // user-2 is a developer of the org and only a plain member of the team.
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_1", userId: "user-2", role: "member", createdAt: "t" }]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers("br_dev"), body: JSON.stringify({ userId: "user-3" }) });
    expect(res.status).toBe(403);
    expect(mocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("allows a team owner (org developer) to manage membership", async () => {
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_1", userId: "user-2", role: "owner", createdAt: "t" }]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers("br_dev"), body: JSON.stringify({ userId: "user-3" }) });
    expect(res.status).toBe(200);
  });

  it("forbids a team ADMIN (org developer) from granting the OWNER role (CWE-863 escalation)", async () => {
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_1", userId: "user-1", role: "owner", createdAt: "t" },
      { teamId: "team_1", userId: "user-2", role: "admin", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers("br_dev"), body: JSON.stringify({ userId: "user-2", role: "owner" }) });
    expect(res.status).toBe(403);
    expect(mocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("lets a team OWNER (org developer) grant the owner role", async () => {
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_1", userId: "user-2", role: "owner", createdAt: "t" }]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers("br_dev"), body: JSON.stringify({ userId: "user-3", role: "owner" }) });
    expect(res.status).toBe(200);
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3", "owner");
  });

  it("forbids a team ADMIN from removing an OWNER", async () => {
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_1", userId: "user-1", role: "owner", createdAt: "t" },
      { teamId: "team_1", userId: "user-2", role: "admin", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members/user-1`, { method: "DELETE", headers: headers("br_dev") });
    expect(res.status).toBe(403);
    expect(mocks.removeTeamMember).not.toHaveBeenCalled();
  });

  it("blocks removing the last owner (no lockout)", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members/user-1`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(400);
    expect(mocks.removeTeamMember).not.toHaveBeenCalled();
  });

  it("removes a member (manager-gated)", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members/user-3`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    expect(mocks.removeTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3");
  });

  it("deletes a team (manager-gated)", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    expect(mocks.deleteTeam).toHaveBeenCalledWith("org-a", "team_1");
  });

  it("blocks access to an org the caller is not a member of (403)", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { headers: headers("br_user", "org-b") });
    expect(res.status).toBe(403);
    expect(mocks.listTeamsForUser).not.toHaveBeenCalled();
  });
});
