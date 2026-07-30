/**
 * B1a Project access integration contract for knowledge operations.
 *
 * The exact lookup returns null for missing, foreign, and inaccessible Projects
 * while preserving the existing open/member/org-admin visibility rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import { resolveKnowledgeProject } from "../knowledge/services/project-access.js";
import { createTestStore } from "./helpers/pgTestStore.js";

test("knowledge Project lookup enforces tenant, restriction, membership, and admin access", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    await store.createUser("knowledge-member", "knowledge-member", "Knowledge Member");
    await store.createOrganization({ orgId: "org-access-a", name: "Access A", slug: "access-a", plan: "enterprise" });
    await store.createOrganization({ orgId: "org-access-b", name: "Access B", slug: "access-b", plan: "enterprise" });
    await store.addOrgMember("org-access-a", "knowledge-member", "developer");

    const createdAt = "2026-07-22T00:00:00.000Z";
    await store.createProject({
      projectId: "project-open-a", orgId: "org-access-a", name: "Open A", slug: "open-a",
      repoUrl: null, restricted: false, createdBy: "knowledge-member", createdAt,
    });
    await store.createProject({
      projectId: "project-restricted-a", orgId: "org-access-a", name: "Restricted A", slug: "restricted-a",
      repoUrl: null, restricted: true, createdBy: "knowledge-member", createdAt,
    });
    await store.createProject({
      projectId: "project-member-a", orgId: "org-access-a", name: "Member A", slug: "member-a",
      repoUrl: null, restricted: true, createdBy: "knowledge-member", createdAt,
    });
    await store.createProject({
      projectId: "project-open-b", orgId: "org-access-b", name: "Open B", slug: "open-b",
      repoUrl: null, restricted: false, createdBy: "knowledge-member", createdAt,
    });
    await store.addProjectMember("project-member-a", "knowledge-member", "developer", createdAt);

    const developer = knowledgeActorFromAuth({
      userId: "knowledge-member", orgId: "org-access-a", role: "developer",
    })!;
    assert.equal((await resolveKnowledgeProject(developer, "project-open-a", store))?.projectId, "project-open-a");
    assert.equal(await resolveKnowledgeProject(developer, "project-restricted-a", store), null);
    assert.equal((await resolveKnowledgeProject(developer, "project-member-a", store))?.projectId, "project-member-a");
    assert.equal(await resolveKnowledgeProject(developer, "project-open-b", store), null);
    assert.equal(await resolveKnowledgeProject(developer, "missing-project", store), null);

    const orgAdmin = knowledgeActorFromAuth({
      userId: "knowledge-member", orgId: "org-access-a", role: "admin",
    })!;
    assert.equal(
      (await resolveKnowledgeProject(orgAdmin, "project-restricted-a", store))?.projectId,
      "project-restricted-a",
    );

    const systemAdmin = knowledgeActorFromAuth({
      userId: "knowledge-member", orgId: "org-access-a", role: "viewer", isAdmin: true,
    })!;
    assert.equal(
      (await resolveKnowledgeProject(systemAdmin, "project-restricted-a", store))?.projectId,
      "project-restricted-a",
    );
    assert.equal(await resolveKnowledgeProject(systemAdmin, "project-open-b", store), null);
  } finally {
    await cleanup();
  }
});
