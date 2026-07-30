import { describe, expect, it, vi } from "vitest";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import { KnowledgeBaseService } from "../knowledge/services/bases.js";
import type { KnowledgeBaseStore } from "../knowledge/store.js";

function base(overrides: Partial<KnowledgeBaseRecord> = {}): KnowledgeBaseRecord {
  return {
    baseId: "kb-1",
    orgId: "org-1",
    projectId: "project-1",
    name: "Engineering",
    description: "Runbooks",
    createdBy: "user-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function setup(projectVisible = true) {
  const record = base();
  const store: KnowledgeBaseStore = {
    getAccessibleProject: vi.fn(async () => projectVisible ? {
      projectId: "project-1",
      orgId: "org-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: null,
      restricted: false,
      createdBy: "user-1",
      createdAt: record.createdAt,
    } : null),
    createKnowledgeBase: vi.fn(async () => undefined),
    getKnowledgeBase: vi.fn(async () => record),
    listKnowledgeBases: vi.fn(async () => [record]),
    updateKnowledgeBase: vi.fn(async (_baseId, _orgId, _projectId, patch) => ({ ...record, ...patch })),
    deleteKnowledgeBase: vi.fn(async () => true),
  };
  return {
    record,
    store,
    service: new KnowledgeBaseService(store, {
      idGenerator: () => "kb-created",
      now: () => "2026-07-22T01:00:00.000Z",
    }),
  };
}

const developer = knowledgeActorFromAuth({
  userId: "user-1",
  orgId: "org-1",
  role: "developer",
})!;
const viewer = knowledgeActorFromAuth({
  userId: "viewer-1",
  orgId: "org-1",
  role: "viewer",
})!;

describe("KnowledgeBaseService", () => {
  it("hides inaccessible Projects before evaluating write permission or input", async () => {
    const { service, store } = setup(false);
    await expect(service.create(viewer, " foreign-project ", { name: " " })).resolves.toEqual({
      ok: false,
      code: "not_found",
    });
    expect(store.createKnowledgeBase).not.toHaveBeenCalled();
  });

  it("allows viewer reads but rejects writes to an accessible Project", async () => {
    const { record, service, store } = setup();
    await expect(service.list(viewer, "project-1")).resolves.toEqual({ ok: true, value: [record] });
    expect(store.listKnowledgeBases).toHaveBeenCalledWith("org-1", "project-1");
    await expect(service.create(viewer, "project-1", { name: "Docs" })).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
  });

  it("normalizes create input and supplies server-owned identity fields", async () => {
    const { service, store } = setup();
    await expect(service.create(developer, " project-1 ", {
      name: " Engineering ",
      description: " Runbooks ",
    })).resolves.toEqual({
      ok: true,
      value: {
        baseId: "kb-created",
        orgId: "org-1",
        projectId: "project-1",
        name: "Engineering",
        description: "Runbooks",
        createdBy: "user-1",
        createdAt: "2026-07-22T01:00:00.000Z",
        updatedAt: "2026-07-22T01:00:00.000Z",
      },
    });
    expect(store.createKnowledgeBase).toHaveBeenCalledOnce();
  });

  it("rejects invalid create and update fields without issuing writes", async () => {
    const { service, store } = setup();
    await expect(service.create(developer, "project-1", { name: " ", description: "ok" })).resolves.toEqual({
      ok: false,
      code: "invalid",
      field: "name",
    });
    await expect(service.update(developer, "project-1", "kb-1", {})).resolves.toEqual({
      ok: false,
      code: "invalid",
      field: "patch",
    });
    await expect(service.update(developer, "project-1", "kb-1", {
      description: "x".repeat(4_001),
    })).resolves.toEqual({ ok: false, code: "invalid", field: "description" });
    expect(store.createKnowledgeBase).not.toHaveBeenCalled();
    expect(store.updateKnowledgeBase).not.toHaveBeenCalled();
  });

  it("maps only the scoped base-name uniqueness constraint to a conflict", async () => {
    const { service, store } = setup();
    vi.mocked(store.createKnowledgeBase).mockRejectedValueOnce(Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "uq_knowledge_bases_project_name",
    }));
    await expect(service.create(developer, "project-1", { name: "Engineering" })).resolves.toEqual({
      ok: false,
      code: "conflict",
      field: "name",
    });

    vi.mocked(store.createKnowledgeBase).mockRejectedValueOnce(Object.assign(new Error("other"), {
      code: "23505",
      constraint: "knowledge_bases_pkey",
    }));
    await expect(service.create(developer, "project-1", { name: "Engineering" })).rejects.toThrow("other");
  });

  it("keeps get, update, and delete scoped to actor organization and resolved Project", async () => {
    const { service, store } = setup();
    await expect(service.get(developer, "project-1", " kb-1 ")).resolves.toMatchObject({ ok: true });
    expect(store.getKnowledgeBase).toHaveBeenCalledWith("kb-1", "org-1", "project-1");

    await expect(service.update(developer, "project-1", " kb-1 ", { name: " Updated " }))
      .resolves.toMatchObject({ ok: true, value: { name: "Updated" } });
    expect(store.updateKnowledgeBase).toHaveBeenCalledWith("kb-1", "org-1", "project-1", {
      name: "Updated",
      updatedAt: "2026-07-22T01:00:00.000Z",
    });

    await expect(service.delete(developer, "project-1", " kb-1 ")).resolves.toEqual({ ok: true, value: true });
    expect(store.deleteKnowledgeBase).toHaveBeenCalledWith("kb-1", "org-1", "project-1");
  });

  it("returns the same not-found result for empty, missing, and raced base IDs", async () => {
    const { service, store } = setup();
    await expect(service.get(developer, "project-1", " ")).resolves.toEqual({ ok: false, code: "not_found" });
    vi.mocked(store.getKnowledgeBase).mockResolvedValueOnce(null);
    await expect(service.get(developer, "project-1", "missing")).resolves.toEqual({ ok: false, code: "not_found" });
    vi.mocked(store.deleteKnowledgeBase).mockResolvedValueOnce(false);
    await expect(service.delete(developer, "project-1", "raced")).resolves.toEqual({ ok: false, code: "not_found" });
  });
});
