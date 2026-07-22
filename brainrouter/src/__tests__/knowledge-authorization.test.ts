/**
 * B1a knowledge authorization unit contract.
 *
 * Actor construction stays independent from Express/MCP and accepts only the
 * trusted context that an authenticated adapter has already resolved.
 */
import { describe, expect, it, vi } from "vitest";
import { canUseKnowledge, knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import { resolveKnowledgeProject } from "../knowledge/services/project-access.js";

describe("knowledge authorization", () => {
  it("derives and normalizes a complete server auth context", () => {
    expect(knowledgeActorFromAuth({
      userId: " user-1 ",
      orgId: " org-1 ",
      role: "member",
      isAdmin: false,
    })).toEqual({
      userId: "user-1",
      orgId: "org-1",
      role: "developer",
      isSystemAdmin: false,
    });
  });

  it("fails closed when authenticated identity, organization, or role is incomplete", () => {
    expect(knowledgeActorFromAuth({ orgId: "org-1", role: "developer" })).toBeNull();
    expect(knowledgeActorFromAuth({ userId: "user-1", role: "developer" })).toBeNull();
    expect(knowledgeActorFromAuth({ userId: "user-1", orgId: "org-1", role: "unknown" })).toBeNull();
    expect(knowledgeActorFromAuth({ userId: " ", orgId: "org-1", role: "owner" })).toBeNull();
  });

  it("applies the knowledge role matrix while retaining the deployment-admin bypass", () => {
    const developer = knowledgeActorFromAuth({ userId: "dev", orgId: "org-1", role: "developer" })!;
    const viewer = knowledgeActorFromAuth({ userId: "view", orgId: "org-1", role: "viewer" })!;
    const systemAdmin = knowledgeActorFromAuth({
      userId: "sys",
      orgId: "org-1",
      role: "viewer",
      isAdmin: true,
    })!;

    expect(canUseKnowledge(developer, "read")).toBe(true);
    expect(canUseKnowledge(developer, "write")).toBe(true);
    expect(canUseKnowledge(viewer, "read")).toBe(true);
    expect(canUseKnowledge(viewer, "write")).toBe(false);
    expect(canUseKnowledge(systemAdmin, "write")).toBe(true);
  });

  it("resolves an exact Project with server-derived scope and no empty-id query", async () => {
    const actor = knowledgeActorFromAuth({ userId: "user-1", orgId: "org-1", role: "admin" })!;
    const project = {
      projectId: "project-1",
      orgId: "org-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: null,
      restricted: true,
      createdBy: "user-1",
      createdAt: "2026-07-22T00:00:00.000Z",
    };
    const getAccessibleProject = vi.fn(async () => project);

    await expect(resolveKnowledgeProject(actor, " project-1 ", { getAccessibleProject })).resolves.toEqual(project);
    expect(getAccessibleProject).toHaveBeenCalledWith("project-1", "org-1", "user-1", true);

    getAccessibleProject.mockClear();
    await expect(resolveKnowledgeProject(actor, " ", { getAccessibleProject })).resolves.toBeNull();
    expect(getAccessibleProject).not.toHaveBeenCalled();
  });
});
