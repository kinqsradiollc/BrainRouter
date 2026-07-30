import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  listTeamsForUser: vi.fn(),
  getTeam: vi.fn(),
  isTeamMember: vi.fn(),
  listTeamMembers: vi.fn(),
  insertTeamOwner: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  transferPersonalTeamOwnership: vi.fn(),
  deleteTeam: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  getUserById: vi.fn(),
  getUserByEmail: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" }
        : key === "br_dev" ? { userId: "user-2", isAdmin: false, email: "dev@example.test" } : null),
    getUserById: mocks.getUserById,
    getUserByEmail: mocks.getUserByEmail,
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
      insertTeamOwner: mocks.insertTeamOwner,
      addTeamMember: mocks.addTeamMember,
      removeTeamMember: mocks.removeTeamMember,
      transferPersonalTeamOwnership: mocks.transferPersonalTeamOwnership,
      deleteTeam: mocks.deleteTeam,
    },
  },
}));

import { teamsRouter } from "../api/routes/teams.js";

function team(id = "team_1", orgId: string | null = "org-a", kind: "organization" | "personal" = "organization") {
  return { id, kind, orgId, orgName: orgId ? "Acme" : null, ownerUserId: kind === "personal" ? "user-1" : null, name: "Platform", createdBy: "user-1", createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" };
}

describe("teams route — org isolation + management gating", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    mocks.getUserByEmail.mockImplementation(async (email: string) => email === "three@example.test" ? { userId: "user-3", email, status: "active" } : null);
    // user-1 is an org admin of org-a; user-2 is a plain developer of org-a.
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId === `org_personal_${userId}`) return "owner";
      if (orgId !== "org-a") return null;
      return userId === "user-1" ? "admin" : userId === "user-2" || userId === "user-3" ? "developer" : null;
    });
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });
    mocks.listTeamsForUser.mockResolvedValue([team()]);
    mocks.getTeam.mockResolvedValue(team());
    mocks.isTeamMember.mockResolvedValue(true);
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_1", userId: "user-1", role: "owner", displayName: "User One", email: "user@example.test", createdAt: "t" }]);
    mocks.createTeam.mockImplementation(async (input: Record<string, unknown>) => team(String(input.id), input.orgId == null ? null : String(input.orgId), input.kind === "personal" ? "personal" : "organization"));
    mocks.insertTeamOwner.mockResolvedValue(true);
    mocks.addTeamMember.mockResolvedValue(true);
    mocks.removeTeamMember.mockResolvedValue(true);
    mocks.transferPersonalTeamOwnership.mockResolvedValue(true);
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
    expect(mocks.listTeamsForUser).toHaveBeenCalledWith("org-a", "user-1", true);
  });

  it("creates a team scoped to the caller's org", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Platform" }) });
    expect(res.status).toBe(201);
    expect(mocks.createTeam.mock.calls[0]![0].orgId).toBe("org-a");
    // creator auto-added as owner member via the dedicated bootstrap path
    expect(mocks.insertTeamOwner).toHaveBeenCalledWith(expect.any(String), "user-1");
  });

  it("creates a personal team with no organization container", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Friends", kind: "personal" }) });
    expect(res.status).toBe(201);
    expect(mocks.createTeam.mock.calls[0]![0]).toMatchObject({ kind: "personal", orgId: null, ownerUserId: "user-1" });
  });

  it("requires a shared organization for organization-team creation", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers: headers("br_user", "org_personal_user-1"), body: JSON.stringify({ name: "Not an org team" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/shared organization/i) });
    expect(mocks.createTeam).not.toHaveBeenCalled();
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
    expect(body.currentUserId).toBe("user-1");
  });

  it("hides a team (404) from a non-member, non-admin caller", async () => {
    mocks.isTeamMember.mockResolvedValue(false);
    const res = await fetch(`${baseUrl}/api/teams/team_1`, { headers: headers("br_dev") });
    expect(res.status).toBe(404);
  });

  it("lets an org admin add a member", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers(), body: JSON.stringify({ userId: "user-3", role: "member" }) });
    expect(res.status).toBe(200);
    // caller user-1 is an org admin managing an org team → the override flag rides along.
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3", "member", "user-1", true);
  });

  it("rejects an account outside an organization team", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers(), body: JSON.stringify({ userId: "user-4" }) });
    expect(res.status).toBe(409);
    expect(mocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("allows a personal-team owner to add an active account from another organization by email", async () => {
    mocks.getTeam.mockResolvedValue(team("team_personal", null, "personal"));
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_personal", userId: "user-1", role: "owner", displayName: "", email: "", createdAt: "t" }]);
    const res = await fetch(`${baseUrl}/api/teams/team_personal/members`, { method: "POST", headers: headers(), body: JSON.stringify({ email: "three@example.test" }) });
    expect(res.status).toBe(200);
    // personal team → no org-admin override; caller user-1 is threaded through.
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_personal", "user-3", "member", "user-1", false);
  });

  it("does not give an organization admin an override on a personal team", async () => {
    mocks.getTeam.mockResolvedValue(team("team_personal", null, "personal"));
    mocks.listTeamMembers.mockResolvedValue([{ teamId: "team_personal", userId: "user-2", role: "owner", displayName: "", email: "", createdAt: "t" }]);
    const res = await fetch(`${baseUrl}/api/teams/team_personal`, { headers: headers() });
    expect(res.status).toBe(404);
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
    // br_dev (user-2) is a team owner but a plain org developer → no org-admin override.
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3", "owner", "user-2", false);
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
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_1", userId: "user-1", role: "owner", displayName: "", email: "", createdAt: "t" },
      { teamId: "team_1", userId: "user-3", role: "member", displayName: "", email: "", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members/user-3`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    // caller user-1 is an org admin on an org team → override flag rides along.
    expect(mocks.removeTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-3", "user-1", true);
  });

  it("lets a regular member leave without management permission", async () => {
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_1", userId: "user-1", role: "owner", displayName: "", email: "", createdAt: "t" },
      { teamId: "team_1", userId: "user-2", role: "member", displayName: "", email: "", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_1/members/user-2`, { method: "DELETE", headers: headers("br_dev") });
    expect(res.status).toBe(200);
    // br_dev (user-2) self-leaves as a plain org developer → no override.
    expect(mocks.removeTeamMember).toHaveBeenCalledWith("org-a", "team_1", "user-2", "user-2", false);
  });

  it("blocks demoting the last owner", async () => {
    const res = await fetch(`${baseUrl}/api/teams/team_1/members`, { method: "POST", headers: headers(), body: JSON.stringify({ userId: "user-1", role: "member" }) });
    expect(res.status).toBe(400);
    expect(mocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("moves personal-team lifecycle ownership before demoting the primary owner", async () => {
    mocks.getTeam.mockResolvedValue(team("team_personal", null, "personal"));
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_personal", userId: "user-1", role: "owner", createdAt: "t" },
      { teamId: "team_personal", userId: "user-3", role: "owner", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_personal/members`, { method: "POST", headers: headers(), body: JSON.stringify({ userId: "user-1", role: "member" }) });
    expect(res.status).toBe(200);
    expect(mocks.transferPersonalTeamOwnership).toHaveBeenCalledWith("team_personal", "user-1", "user-3");
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-a", "team_personal", "user-1", "member", "user-1", false);
  });

  it("moves personal-team lifecycle ownership before the primary owner leaves", async () => {
    mocks.getTeam.mockResolvedValue(team("team_personal", null, "personal"));
    mocks.listTeamMembers.mockResolvedValue([
      { teamId: "team_personal", userId: "user-1", role: "owner", createdAt: "t" },
      { teamId: "team_personal", userId: "user-3", role: "owner", createdAt: "t" },
    ]);
    const res = await fetch(`${baseUrl}/api/teams/team_personal/members/user-1`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    expect(mocks.transferPersonalTeamOwnership).toHaveBeenCalledWith("team_personal", "user-1", "user-3");
    expect(mocks.removeTeamMember).toHaveBeenCalledWith("org-a", "team_personal", "user-1", "user-1", false);
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
