import { describe, expect, it, vi } from "vitest";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type {
  KnowledgeDerivedDocumentInput,
  KnowledgeDocumentRecord,
} from "../knowledge/contracts/document.js";
import { KnowledgeDistillationService } from "../knowledge/services/distillation.js";
import type { KnowledgeDocumentStore } from "../knowledge/store.js";

const at = "2026-07-26T00:00:00.000Z";

function document(
  documentId: string,
  overrides: Partial<KnowledgeDocumentRecord> = {},
): KnowledgeDocumentRecord {
  return {
    documentId,
    baseId: "base-1",
    orgId: "org-1",
    projectId: "project-1",
    title: `Source ${documentId}`,
    sourceName: `${documentId}.md`,
    sourceFormat: "markdown",
    contentText: `Grounded content from ${documentId}`,
    contentSha256: "a".repeat(64),
    origin: "source",
    distillationVersion: null,
    status: "ready",
    statusMessage: null,
    parseVersion: 1,
    createdBy: "user-1",
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    ...overrides,
  };
}

function setup(options: {
  sources?: KnowledgeDocumentRecord[];
  modelOutput?: unknown;
} = {}) {
  const sources = options.sources ?? [document("source-1"), document("source-2")];
  const enqueueDerivedKnowledgeDocuments = vi.fn(async (
    inputs: KnowledgeDerivedDocumentInput[],
  ) => inputs.map((input) => ({
    document: input.document,
    sourceDocumentIds: input.sourceDocumentIds,
    created: true,
    jobId: input.jobId,
  })));
  const store = {
    getAccessibleProject: vi.fn(async () => ({
      projectId: "project-1",
      orgId: "org-1",
      name: "Project",
      slug: "project",
      repoUrl: null,
      restricted: false,
      createdBy: "user-1",
      createdAt: at,
    })),
    getKnowledgeBase: vi.fn(async () => ({
      baseId: "base-1",
      orgId: "org-1",
      projectId: "project-1",
      name: "Base",
      description: "",
      createdBy: "user-1",
      createdAt: at,
      updatedAt: at,
    })),
    listKnowledgeDocuments: vi.fn(async () => sources),
    getKnowledgeDocument: vi.fn(async (documentId: string) =>
      sources.find((source) => source.documentId === documentId) ?? null),
    enqueueDerivedKnowledgeDocuments,
  } as unknown as KnowledgeDocumentStore;
  const run = vi.fn(async () => JSON.stringify(options.modelOutput ?? {
    notes: [{
      title: "Deployment model",
      markdown: "# Deployment model\n\nSupported facts only.\n\nTOKEN=secret-value",
      sourceDocumentIds: ["source-1", "source-2"],
    }],
  }));
  let documentSequence = 0;
  let jobSequence = 0;
  const service = new KnowledgeDistillationService(store, {
    resolveRunner: vi.fn(async () => ({ run })),
    documentIdGenerator: () => `derived-${++documentSequence}`,
    jobIdGenerator: () => `job-${++jobSequence}`,
    now: () => at,
  });
  return { service, store, run, enqueueDerivedKnowledgeDocuments };
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

describe("KnowledgeDistillationService", () => {
  it("requires explicit opt-in and stores bounded derived notes with exact provenance", async () => {
    const { service, store, run, enqueueDerivedKnowledgeDocuments } = setup();
    const result = await service.distill(developer, "project-1", "base-1", {
      confirmed: true,
      maxNotes: 4,
    });

    expect(result.ok).toBe(true);
    expect(store.listKnowledgeDocuments).toHaveBeenCalledWith(
      "base-1",
      "org-1",
      "project-1",
      { status: "ready", origin: "source", limit: 20 },
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "knowledge-distillation",
      tool: expect.objectContaining({ name: "format_knowledge_notes" }),
    }));
    const queued = enqueueDerivedKnowledgeDocuments.mock.calls[0]?.[0] ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sourceDocumentIds: ["source-1", "source-2"],
      document: {
        documentId: "derived-1",
        origin: "derived",
        distillationVersion: 1,
        sourceFormat: "markdown",
        status: "queued",
      },
    });
    expect(queued[0]?.document.contentText).not.toContain("secret-value");
  });

  it("redacts source secrets before provider egress", async () => {
    const { service, run } = setup({
      sources: [document("source-1", {
        title: "TOKEN=title-secret",
        contentText: "API_KEY=source-secret",
      })],
      modelOutput: {
        notes: [{
          title: "Safe note",
          markdown: "Supported body",
          sourceDocumentIds: ["source-1"],
        }],
      },
    });

    await expect(service.distill(developer, "project-1", "base-1", {
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    const calls = run.mock.calls as unknown as Array<Array<{ prompt?: string }>>;
    const prompt = String(calls[0]?.[0]?.prompt);
    expect(prompt).not.toContain("title-secret");
    expect(prompt).not.toContain("source-secret");
  });

  it("rejects missing confirmation and viewer writes before model execution", async () => {
    const { service, run, enqueueDerivedKnowledgeDocuments } = setup();

    await expect(service.distill(developer, "project-1", "base-1", {
      confirmed: false,
    } as never)).resolves.toEqual({
      ok: false,
      code: "invalid",
      field: "confirmed",
    });
    await expect(service.distill(viewer, "project-1", "base-1", {
      confirmed: true,
    })).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(run).not.toHaveBeenCalled();
    expect(enqueueDerivedKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it("excludes derived or unready documents from explicit recursive input", async () => {
    const derived = document("derived-1", {
      origin: "derived",
      distillationVersion: 1,
    });
    const { service, run, enqueueDerivedKnowledgeDocuments } = setup({
      sources: [derived],
    });

    await expect(service.distill(developer, "project-1", "base-1", {
      confirmed: true,
      documentIds: ["derived-1"],
    })).resolves.toEqual({ ok: false, code: "not_found" });
    expect(run).not.toHaveBeenCalled();
    expect(enqueueDerivedKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it("rejects fabricated provenance and malformed model output without writes", async () => {
    const { service, enqueueDerivedKnowledgeDocuments } = setup({
      modelOutput: {
        notes: [{
          title: "Unsupported",
          markdown: "Unsupported body",
          sourceDocumentIds: ["foreign-document"],
        }],
      },
    });

    await expect(service.distill(developer, "project-1", "base-1", {
      confirmed: true,
    })).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(enqueueDerivedKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it("rejects raw HTML, dangerous Markdown links, and undeclared output fields", async () => {
    for (const note of [
      {
        title: "<script>alert(1)</script>",
        markdown: "Supported body",
        sourceDocumentIds: ["source-1"],
      },
      {
        title: "Unsafe HTML",
        markdown: "<script>alert(1)</script>",
        sourceDocumentIds: ["source-1"],
      },
      {
        title: "Unsafe link",
        markdown: "[open](javascript:alert(1))",
        sourceDocumentIds: ["source-1"],
      },
      {
        title: "Unexpected field",
        markdown: "Supported body",
        sourceDocumentIds: ["source-1"],
        instruction: "persist this",
      },
    ]) {
      const { service, enqueueDerivedKnowledgeDocuments } = setup({
        modelOutput: { notes: [note] },
      });
      await expect(service.distill(developer, "project-1", "base-1", {
        confirmed: true,
      })).resolves.toEqual({ ok: false, code: "unavailable" });
      expect(enqueueDerivedKnowledgeDocuments).not.toHaveBeenCalled();
    }
  });
});
