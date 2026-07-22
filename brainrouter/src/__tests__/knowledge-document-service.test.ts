import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import type { KnowledgeDocumentRecord } from "../knowledge/contracts/document.js";
import { MAX_KNOWLEDGE_TEXT_BYTES } from "../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../knowledge/services/documents.js";
import type { KnowledgeDocumentStore } from "../knowledge/store.js";

const at = "2026-07-22T02:00:00.000Z";

function setup(options: { projectVisible?: boolean; baseVisible?: boolean } = {}) {
  const base: KnowledgeBaseRecord = {
    baseId: "base-1",
    orgId: "org-1",
    projectId: "project-1",
    name: "Engineering",
    description: "",
    createdBy: "user-1",
    createdAt: at,
    updatedAt: at,
  };
  const store: KnowledgeDocumentStore = {
    getAccessibleProject: vi.fn(async () => options.projectVisible === false ? null : {
      projectId: "project-1",
      orgId: "org-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: null,
      restricted: false,
      createdBy: "user-1",
      createdAt: at,
    }),
    createKnowledgeBase: vi.fn(async () => undefined),
    getKnowledgeBase: vi.fn(async () => options.baseVisible === false ? null : base),
    listKnowledgeBases: vi.fn(async () => [base]),
    updateKnowledgeBase: vi.fn(async () => base),
    deleteKnowledgeBase: vi.fn(async () => true),
    enqueueKnowledgeDocument: vi.fn(async (document: KnowledgeDocumentRecord, jobId: string) => ({
      document,
      created: true,
      jobId,
    })),
    markKnowledgeDocumentParsing: vi.fn(async () => null),
    commitKnowledgeDocumentParse: vi.fn(async () => null),
    failKnowledgeDocumentParse: vi.fn(async () => null),
    listKnowledgeChunks: vi.fn(async () => []),
    upsertKnowledgeChunkEmbeddings: vi.fn(async () => 0),
    createKnowledgeDocument: vi.fn(async () => undefined),
    getKnowledgeDocument: vi.fn(async () => null),
    getKnowledgeDocumentByContentHash: vi.fn(async () => null),
    listKnowledgeDocuments: vi.fn(async () => []),
    updateKnowledgeDocumentStatus: vi.fn(async () => null),
  };
  return {
    store,
    service: new KnowledgeDocumentService(store, {
      documentIdGenerator: () => "document-created",
      jobIdGenerator: () => "job-created",
      now: () => at,
    }),
  };
}

const developer = knowledgeActorFromAuth({
  userId: "user-1", orgId: "org-1", role: "developer",
})!;
const viewer = knowledgeActorFromAuth({
  userId: "viewer-1", orgId: "org-1", role: "viewer",
})!;

describe("KnowledgeDocumentService", () => {
  it("hides inaccessible Projects before permission and payload validation", async () => {
    const { service, store } = setup({ projectVisible: false });
    await expect(service.ingestText(viewer, "foreign", "", {
      title: "",
      sourceFormat: "text",
      content: "",
    })).resolves.toEqual({ ok: false, code: "not_found" });
    expect(store.getKnowledgeBase).not.toHaveBeenCalled();
    expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("checks write permission and exact base ancestry before payload work", async () => {
    const viewerSetup = setup();
    await expect(viewerSetup.service.ingestText(viewer, "project-1", "base-1", {
      title: "Docs",
      sourceFormat: "text",
      content: "Body",
    })).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(viewerSetup.store.getKnowledgeBase).not.toHaveBeenCalled();

    const missingBase = setup({ baseVisible: false });
    await expect(missingBase.service.ingestText(developer, "project-1", "missing", {
      title: "",
      sourceFormat: "text",
      content: "",
    })).resolves.toEqual({ ok: false, code: "not_found" });
    expect(missingBase.store.getKnowledgeBase).toHaveBeenCalledWith("missing", "org-1", "project-1");
    expect(missingBase.store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("normalizes and redacts before hashing or atomic enqueue", async () => {
    const { service, store } = setup();
    const expectedContent = "First line\n[REDACTED]\nLast line";
    const result = await service.ingestText(developer, " project-1 ", " base-1 ", {
      title: " Runbook ",
      sourceName: " runbook.md ",
      sourceFormat: "markdown",
      content: " First line\r\nSECRET_TOKEN=abc123\rLast line ",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { created: true, jobId: "job-created" },
    });
    const [record, jobId] = vi.mocked(store.enqueueKnowledgeDocument).mock.calls[0];
    expect(jobId).toBe("job-created");
    expect(record).toEqual({
      documentId: "document-created",
      baseId: "base-1",
      orgId: "org-1",
      projectId: "project-1",
      title: "Runbook",
      sourceName: "runbook.md",
      sourceFormat: "markdown",
      contentText: expectedContent,
      contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
      status: "queued",
      statusMessage: null,
      parseVersion: 1,
      createdBy: "user-1",
      createdAt: at,
      updatedAt: at,
      readyAt: null,
    });
  });

  it("rejects invalid metadata, formats, empty content, and oversized raw bytes", async () => {
    const cases = [
      [{ title: "", sourceFormat: "text", content: "Body" }, "title"],
      [{ title: "Docs", sourceName: "x".repeat(501), sourceFormat: "text", content: "Body" }, "sourceName"],
      [{ title: "Docs", sourceFormat: "html", content: "Body" }, "sourceFormat"],
      [{ title: "Docs", sourceFormat: "text", content: " \r\n " }, "content"],
      [{ title: "Docs", sourceFormat: "text", content: "é".repeat((MAX_KNOWLEDGE_TEXT_BYTES / 2) + 1) }, "content"],
    ] as const;
    for (const [input, field] of cases) {
      const { service, store } = setup();
      await expect(service.ingestText(developer, "project-1", "base-1", input as any))
        .resolves.toEqual({ ok: false, code: "invalid", field });
      expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
    }
  });

  it("returns store dedupe truth and hides a raced base deletion", async () => {
    const dedupe = setup();
    vi.mocked(dedupe.store.enqueueKnowledgeDocument).mockImplementationOnce(async (document) => ({
      document: { ...document, documentId: "existing-document" },
      created: false,
      jobId: null,
    }));
    await expect(dedupe.service.ingestText(developer, "project-1", "base-1", {
      title: "Docs", sourceFormat: "text", content: "Body",
    })).resolves.toMatchObject({
      ok: true,
      value: { created: false, jobId: null, document: { documentId: "existing-document" } },
    });

    const raced = setup();
    vi.mocked(raced.store.enqueueKnowledgeDocument).mockRejectedValueOnce(
      Object.assign(new Error("foreign key"), { code: "23503" }),
    );
    await expect(raced.service.ingestText(developer, "project-1", "base-1", {
      title: "Docs", sourceFormat: "text", content: "Body",
    })).resolves.toEqual({ ok: false, code: "not_found" });
  });
});
