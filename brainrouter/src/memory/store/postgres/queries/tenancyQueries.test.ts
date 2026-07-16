import { describe, expect, it, vi } from "vitest";
import { getMemberRole, listOrgMembershipsForUser, listOrgMembers } from "./tenancyQueries.js";

function orgRow(roleField: "role" | "member_role", role: string) {
  return {
    org_id: "org-team",
    user_id: "user-1",
    name: "Team",
    slug: "team",
    plan: "team",
    allowed_domains: [],
    created_at: "2026-07-15T00:00:00.000Z",
    [roleField]: role,
  };
}

describe("tenancy query role compatibility", () => {
  it.each([
    ["member", "developer"],
    ["manager", "admin"],
  ] as const)("normalizes legacy %s roles for authorization", async (storedRole, expectedRole) => {
    const exec = {
      one: vi.fn(async () => ({ role: storedRole })),
    } as any;

    await expect(getMemberRole(exec, "org-team", "user-1")).resolves.toBe(expectedRole);
  });

  it("normalizes legacy roles in organization listings", async () => {
    const exec = {
      rows: vi
        .fn()
        .mockResolvedValueOnce([orgRow("role", "member")])
        .mockResolvedValueOnce([orgRow("member_role", "manager")]),
    } as any;

    await expect(listOrgMembers(exec, "org-team")).resolves.toMatchObject([{ role: "developer" }]);
    await expect(listOrgMembershipsForUser(exec, "user-1")).resolves.toMatchObject([{ role: "admin" }]);
  });

  it("does not turn an unknown stored role into membership", async () => {
    const exec = {
      one: vi.fn(async () => ({ role: "unexpected-role" })),
    } as any;

    await expect(getMemberRole(exec, "org-team", "user-1")).resolves.toBeNull();
  });
});
