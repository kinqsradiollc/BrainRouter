import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  listTeamsForUser: vi.fn(),
  getTeam: vi.fn(),
  isTeamMember: vi.fn(),
  listTeamMembers: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  deleteTeam: vi.fn(),
}));

vi.mock("../engine.js", () => ({
  memoryEngine: { store: mocks },
}));

import { createTeam, assertUserInTeam, TeamMembershipError } from "./backend.js";

describe("teams backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTeam.mockImplementation(async (input: Record<string, unknown>) => ({
      id: String(input.id), orgId: String(input.orgId), name: String(input.name),
      createdBy: String(input.createdBy), createdAt: "t", updatedAt: "t",
    }));
    mocks.addTeamMember.mockResolvedValue(true);
  });

  it("createTeam trims the name and auto-adds the creator as owner", async () => {
    const team = await createTeam("org-1", "user-1", "  Platform  ");
    expect(team.name).toBe("Platform");
    expect(mocks.createTeam.mock.calls[0]![0]).toMatchObject({ orgId: "org-1", name: "Platform", createdBy: "user-1" });
    expect(mocks.createTeam.mock.calls[0]![0].id).toMatch(/^team_/);
    expect(mocks.addTeamMember).toHaveBeenCalledWith("org-1", team.id, "user-1", "owner");
  });

  it("createTeam rejects an empty name", async () => {
    await expect(createTeam("org-1", "user-1", "   ")).rejects.toThrow(/name is required/i);
    expect(mocks.createTeam).not.toHaveBeenCalled();
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
});
