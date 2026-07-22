import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import { KnowledgeBaseService } from "../knowledge/services/bases.js";
import { createTestStore } from "./helpers/pgTestStore.js";

test("knowledge base CRUD stays bound to actor organization and Project", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    await store.createUser("base-user", "base-user", "Base User");
    await store.createOrganization({ orgId: "base-org-a", name: "Base Org A", slug: "base-org-a" });
    await store.createOrganization({ orgId: "base-org-b", name: "Base Org B", slug: "base-org-b" });
    await store.addOrgMember("base-org-a", "base-user", "developer");
    await store.addOrgMember("base-org-b", "base-user", "developer");

    const createdAt = "2026-07-22T00:00:00.000Z";
    for (const project of [
      { projectId: "base-project-a1", orgId: "base-org-a", slug: "base-a1" },
      { projectId: "base-project-a2", orgId: "base-org-a", slug: "base-a2" },
      { projectId: "base-project-b1", orgId: "base-org-b", slug: "base-b1" },
    ]) {
      await store.createProject({
        ...project,
        name: project.projectId,
        repoUrl: null,
        restricted: false,
        createdBy: "base-user",
        createdAt,
      });
    }

    const actorA = knowledgeActorFromAuth({
      userId: "base-user", orgId: "base-org-a", role: "developer",
    })!;
    const actorB = knowledgeActorFromAuth({
      userId: "base-user", orgId: "base-org-b", role: "developer",
    })!;
    const service = new KnowledgeBaseService(store, {
      idGenerator: () => "base-record-a",
      now: () => "2026-07-22T01:00:00.000Z",
    });

    const created = await service.create(actorA, "base-project-a1", {
      name: " Engineering ", description: " Runbooks ",
    });
    assert.equal(created.ok, true);
    const duplicateService = new KnowledgeBaseService(store, {
      idGenerator: () => "base-record-duplicate",
      now: () => "2026-07-22T01:01:00.000Z",
    });
    assert.deepEqual(await duplicateService.create(actorA, "base-project-a1", {
      name: "engineering",
    }), { ok: false, code: "conflict", field: "name" });
    assert.deepEqual(await service.list(actorA, "base-project-a1"), created.ok
      ? { ok: true, value: [created.value] }
      : null);
    assert.deepEqual(await service.list(actorA, "base-project-a2"), { ok: true, value: [] });
    assert.deepEqual(await service.get(actorA, "base-project-a2", "base-record-a"), {
      ok: false, code: "not_found",
    });
    assert.deepEqual(await service.get(actorB, "base-project-b1", "base-record-a"), {
      ok: false, code: "not_found",
    });

    const updated = await service.update(actorA, "base-project-a1", "base-record-a", {
      name: "Platform",
      description: "Owned docs",
    });
    assert.equal(updated.ok && updated.value.name, "Platform");
    assert.equal(updated.ok && updated.value.description, "Owned docs");
    assert.deepEqual(await service.delete(actorA, "base-project-a2", "base-record-a"), {
      ok: false, code: "not_found",
    });
    assert.deepEqual(await service.delete(actorA, "base-project-a1", "base-record-a"), {
      ok: true, value: true,
    });
    assert.deepEqual(await service.get(actorA, "base-project-a1", "base-record-a"), {
      ok: false, code: "not_found",
    });
  } finally {
    await cleanup();
  }
});
