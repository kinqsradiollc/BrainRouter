import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("../engine.js", () => ({
  memoryEngine: { store: mocks },
}));

import { createTeam, assertUserCanShareToTeam, assertUserInTeam, TeamMembershipError } from "./backend.js";

describe("teams backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTeam.mockImplementation(async (input: Record<string, unknown>) => ({
      id: String(input.id), kind: input.kind, orgId: input.orgId, ownerUserId: input.ownerUserId, orgName: null, name: String(input.name),
      createdBy: String(input.createdBy), createdAt: "t", updatedAt: "t",
    }));
    mocks.addTeamMember.mockResolvedValue(true);
    mocks.insertTeamOwner.mockResolvedValue(true);
  });

  it("createTeam trims the name and auto-adds the creator as owner", async () => {
    const team = await createTeam("org-1", "user-1", "  Platform  ");
    expect(team.name).toBe("Platform");
    expect(mocks.createTeam.mock.calls[0]![0]).toMatchObject({ orgId: "org-1", name: "Platform", createdBy: "user-1" });
    expect(mocks.createTeam.mock.calls[0]![0].id).toMatch(/^team_/);
    // Bootstrap goes through a dedicated owner-insert, not the authz-checked addTeamMember.
    expect(mocks.insertTeamOwner).toHaveBeenCalledWith(team.id, "user-1");
    expect(mocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("createTeam rejects an empty name", async () => {
    await expect(createTeam("org-1", "user-1", "   ")).rejects.toThrow(/name is required/i);
    expect(mocks.createTeam).not.toHaveBeenCalled();
  });

  it("creates a personal team outside an organization without changing membership scope", async () => {
    const team = await createTeam("org-active", "user-1", "Friends", "personal");
    expect(team).toMatchObject({ kind: "personal", orgId: null, ownerUserId: "user-1" });
    expect(mocks.insertTeamOwner).toHaveBeenCalledWith(team.id, "user-1");
  });

  it("assertUserInTeam passes when the store confirms membership", async () => {
    mocks.isTeamMember.mockResolvedValue(true);
    await expect(assertUserInTeam("org-1", "user-1", "team_1")).resolves.toBeUndefined();
    expect(mocks.isTeamMember).toHaveBeenCalledWith("org-1", "team_1", "user-1");
  });

  it("assertUserInTeam throws TeamMembershipError when not a member (or wrong org)", async () => {
    mocks.isTeamMember.mockResolvedValue(false);
    await expect(assertUserInTeam("org-1", "user-1", "team_1")).rejects.toBeInstanceOf(TeamMembershipError);
  });

  it("assertUserInTeam throws without hitting the store for an empty teamId", async () => {
    await expect(assertUserInTeam("org-1", "user-1", "")).rejects.toBeInstanceOf(TeamMembershipError);
    expect(mocks.isTeamMember).not.toHaveBeenCalled();
  });

  it("allows an organization admin to share to a same-org organization team without membership", async () => {
    mocks.isTeamMember.mockResolvedValue(false);
    mocks.getTeam.mockResolvedValue({ id: "team_1", kind: "organization", orgId: "org-1" });
    await expect(assertUserCanShareToTeam("org-1", "admin-1", "team_1", true)).resolves.toBeUndefined();
  });

  it("never gives an organization admin an override on a personal team", async () => {
    mocks.isTeamMember.mockResolvedValue(false);
    mocks.getTeam.mockResolvedValue({ id: "team_p", kind: "personal", orgId: null });
    await expect(assertUserCanShareToTeam("org-1", "admin-1", "team_p", true)).rejects.toBeInstanceOf(TeamMembershipError);
  });
});
