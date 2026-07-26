import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import type { KnowledgeDocumentRecord } from "../knowledge/contracts/document.js";
import {
  MAX_KNOWLEDGE_DOCX_BASE64_CHARS,
  MAX_KNOWLEDGE_HTML_BYTES,
  MAX_KNOWLEDGE_PDF_BASE64_CHARS,
  MAX_KNOWLEDGE_TEXT_BYTES,
} from "../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../knowledge/services/documents.js";
import type { KnowledgeDocumentStore } from "../knowledge/store.js";

const at = "2026-07-22T02:00:00.000Z";

function setup(options: {
  projectVisible?: boolean;
  baseVisible?: boolean;
  documentVisible?: boolean;
} = {}) {
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
  const document: KnowledgeDocumentRecord = {
    documentId: "document-1",
    baseId: "base-1",
    orgId: "org-1",
    projectId: "project-1",
    title: "Runbook",
    sourceName: "runbook.md",
    sourceFormat: "markdown",
    contentText: "Sensitive body",
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
    searchKnowledgeChunksByText: vi.fn(async () => []),
    searchKnowledgeChunksByVector: vi.fn(async () => []),
    enqueueKnowledgeDocument: vi.fn(async (document: KnowledgeDocumentRecord, jobId: string) => ({
      document,
      created: true,
      jobId,
    })),
    enqueueDerivedKnowledgeDocuments: vi.fn(async () => []),
    markKnowledgeDocumentParsing: vi.fn(async () => null),
    commitKnowledgeDocumentParse: vi.fn(async () => null),
    failKnowledgeDocumentParse: vi.fn(async () => null),
    listKnowledgeChunks: vi.fn(async () => []),
    upsertKnowledgeChunkEmbeddings: vi.fn(async () => 0),
    getKnowledgeDocumentProcessing: vi.fn(async () => ({
      document,
      jobState: "done" as const,
      attempts: 1,
      maxAttempts: 3,
      chunkCount: 2,
      embeddingCount: 2,
    })),
    retryKnowledgeDocumentProcessing: vi.fn(async () => ({
      document,
      jobState: "pending" as const,
      enqueued: true,
    })),
    createKnowledgeDocument: vi.fn(async () => undefined),
    getKnowledgeDocument: vi.fn(async () => options.documentVisible === false ? null : document),
    listKnowledgeDocumentSourceIds: vi.fn(async () => []),
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

function pdfBase64(text = "Deployment\nSECRET_TOKEN=abc123"): string {
  const literal = text.replace(/[\\()]/g, "\\$&").replace(/\n/g, "\\n");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (${literal}) Tj ET\n%%EOF`,
    "latin1",
  ).toString("base64");
}

function docxBase64(documentText = "Deployment\nSECRET_TOKEN=abc123"): string {
  const paragraphs = documentText
    .split("\n")
    .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
    .join("");
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<Types>
      <Override PartName="/word/document.xml"
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`),
    "_rels/.rels": strToU8(`<Relationships>
      <Relationship Type="officeDocument" Target="word/document.xml"/>
    </Relationships>`),
    "word/document.xml": strToU8(`<w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>${paragraphs}</w:body>
    </w:document>`),
  }, { level: 6 })).toString("base64");
}

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
      origin: "source",
      distillationVersion: null,
      status: "queued",
      statusMessage: null,
      parseVersion: 1,
      createdBy: "user-1",
      createdAt: at,
      updatedAt: at,
      readyAt: null,
    });
  });

  it("extracts and redacts bounded HTML before persistence or enqueue", async () => {
    const { service, store } = setup();
    const expectedContent = "Deployment\n[REDACTED]\nRead the guide";
    const result = await service.ingestText(developer, "project-1", "base-1", {
      title: "Deployment page",
      sourceName: "deployment.html",
      sourceFormat: "html",
      content: `<html><head><title>Not persisted</title></head><body>
        <h1>Deployment</h1><p>SECRET_TOKEN=abc123</p>
        <script>fetch('https://internal.invalid/credential')</script>
        <a href="file:///private/host/path">Read the guide</a>
      </body></html>`,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    const [record] = vi.mocked(store.enqueueKnowledgeDocument).mock.calls[0];
    expect(record).toMatchObject({
      sourceFormat: "html",
      contentText: expectedContent,
      contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
    });
    expect(JSON.stringify(record)).not.toMatch(/<script|internal\.invalid|file:\/\/|abc123/);
  });

  it("extracts and redacts a bounded PDF without persisting its binary payload", async () => {
    const { service, store } = setup();
    const rawContent = pdfBase64();
    const expectedContent = "Deployment\n[REDACTED]";
    const result = await service.ingestPdf(developer, "project-1", "base-1", {
      title: "Deployment guide",
      sourceName: "deployment.pdf",
      contentBase64: rawContent,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    const [record, jobId] = vi.mocked(store.enqueueKnowledgeDocument).mock.calls[0];
    expect(jobId).toBe("job-created");
    expect(record).toMatchObject({
      sourceFormat: "pdf",
      contentText: expectedContent,
      contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
    });
    const serializedRecord = JSON.stringify(record);
    expect(serializedRecord).not.toContain(rawContent);
    expect(serializedRecord).not.toContain("abc123");
  });

  it("rejects non-canonical, oversized, non-PDF, and text-free PDF payloads", async () => {
    const cases = [
      "file:///private/runbook.pdf",
      "data:application/pdf;base64,JVBERi0xLjQ=",
      Buffer.from("not a PDF").toString("base64"),
      Buffer.from("%PDF-1.4\n%%EOF", "latin1").toString("base64"),
      "A".repeat(MAX_KNOWLEDGE_PDF_BASE64_CHARS + 1),
    ];
    for (const contentBase64 of cases) {
      const { service, store } = setup();
      await expect(service.ingestPdf(developer, "project-1", "base-1", {
        title: "Invalid PDF",
        contentBase64,
      })).resolves.toEqual({ ok: false, code: "invalid", field: "contentBase64" });
      expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
    }
  });

  it("authorizes PDF writes before decoding attacker-controlled content", async () => {
    const { service, store } = setup();
    await expect(service.ingestPdf(viewer, "project-1", "base-1", {
      title: "Escalation attempt",
      contentBase64: "not-base64",
    })).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(store.getKnowledgeBase).not.toHaveBeenCalled();
    expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("extracts and redacts a bounded DOCX without persisting package content", async () => {
    const { service, store } = setup();
    const rawContent = docxBase64();
    const expectedContent = "Deployment\n[REDACTED]";
    const result = await service.ingestDocx(developer, "project-1", "base-1", {
      title: "Deployment runbook",
      sourceName: "deployment.docx",
      contentBase64: rawContent,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    const [record, jobId] = vi.mocked(store.enqueueKnowledgeDocument).mock.calls[0];
    expect(jobId).toBe("job-created");
    expect(record).toMatchObject({
      sourceFormat: "docx",
      contentText: expectedContent,
      contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
    });
    const serializedRecord = JSON.stringify(record);
    expect(serializedRecord).not.toContain(rawContent);
    expect(serializedRecord).not.toContain("abc123");
    expect(serializedRecord).not.toContain("[Content_Types].xml");
  });

  it("rejects non-canonical, oversized, non-DOCX, and text-free DOCX payloads", async () => {
    const textFreeDocx = docxBase64("");
    const cases = [
      "file:///private/runbook.docx",
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==",
      Buffer.from("not a DOCX").toString("base64"),
      textFreeDocx,
      "A".repeat(MAX_KNOWLEDGE_DOCX_BASE64_CHARS + 1),
    ];
    for (const contentBase64 of cases) {
      const { service, store } = setup();
      await expect(service.ingestDocx(developer, "project-1", "base-1", {
        title: "Invalid DOCX",
        contentBase64,
      })).resolves.toEqual({ ok: false, code: "invalid", field: "contentBase64" });
      expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
    }
  });

  it("authorizes DOCX writes before decoding attacker-controlled content", async () => {
    const { service, store } = setup();
    await expect(service.ingestDocx(viewer, "project-1", "base-1", {
      title: "Escalation attempt",
      contentBase64: "not-base64",
    })).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(store.getKnowledgeBase).not.toHaveBeenCalled();
    expect(store.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("rejects invalid metadata, formats, empty content, and oversized raw bytes", async () => {
    const cases = [
      [{ title: "", sourceFormat: "text", content: "Body" }, "title"],
      [{ title: "Docs", sourceName: "x".repeat(501), sourceFormat: "text", content: "Body" }, "sourceName"],
      [{ title: "Docs", sourceFormat: "pdf", content: "Body" }, "sourceFormat"],
      [{ title: "Docs", sourceFormat: "text", content: " \r\n " }, "content"],
      [{ title: "Docs", sourceFormat: "text", content: "é".repeat((MAX_KNOWLEDGE_TEXT_BYTES / 2) + 1) }, "content"],
      [{ title: "Docs", sourceFormat: "html", content: "é".repeat((MAX_KNOWLEDGE_HTML_BYTES / 2) + 1) }, "content"],
      [{ title: "Docs", sourceFormat: "html", content: "<script>only hidden text</script>" }, "content"],
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

  it("returns a content-free status view through exact ancestry", async () => {
    const { service, store } = setup();
    const result = await service.status(viewer, " project-1 ", " base-1 ", " document-1 ");
    expect(result).toEqual({
      ok: true,
      value: {
        documentId: "document-1",
        title: "Runbook",
        sourceName: "runbook.md",
        sourceFormat: "markdown",
        status: "ready",
        statusMessage: null,
        parseVersion: 1,
        updatedAt: at,
        readyAt: at,
        processing: {
          jobState: "done",
          attempts: 1,
          maxAttempts: 3,
          retryable: true,
          chunkCount: 2,
          embeddingCount: 2,
        },
      },
    });
    expect(store.getKnowledgeDocument).toHaveBeenCalledWith(
      "document-1", "base-1", "org-1", "project-1",
    );
    expect(store.getKnowledgeDocumentProcessing).toHaveBeenCalledWith({
      orgId: "org-1",
      projectId: "project-1",
      baseId: "base-1",
      documentId: "document-1",
      parseVersion: 1,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Sensitive body");
    expect(serialized).not.toContain("contentSha256");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("orgId");
    expect(serialized).not.toContain("projectId");
    expect(serialized).not.toContain("job-created");
  });

  it("lists bounded document metadata through exact Project and base ancestry", async () => {
    const { service, store } = setup();
    const listed = await store.getKnowledgeDocument(
      "document-1", "base-1", "org-1", "project-1",
    ) as KnowledgeDocumentRecord;
    vi.mocked(store.listKnowledgeDocuments).mockResolvedValueOnce([listed]);

    const result = await service.list(viewer, " project-1 ", " base-1 ", {
      status: "ready",
      origin: "source",
      limit: "25",
    });

    expect(result).toEqual({
      ok: true,
      value: [{
        documentId: "document-1",
        title: "Runbook",
        sourceName: "runbook.md",
        sourceFormat: "markdown",
        origin: "source",
        status: "ready",
        statusMessage: null,
        parseVersion: 1,
        createdAt: at,
        updatedAt: at,
        readyAt: at,
      }],
    });
    expect(store.listKnowledgeDocuments).toHaveBeenCalledWith(
      "base-1",
      "org-1",
      "project-1",
      { status: "ready", origin: "source", limit: 25 },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Sensitive body");
    expect(serialized).not.toContain("contentSha256");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("orgId");
    expect(serialized).not.toContain("projectId");
  });

  it("authorizes document listing before validating bounded filters", async () => {
    const hidden = setup({ projectVisible: false });
    await expect(hidden.service.list(viewer, "foreign", "base-1", {
      status: "not-a-status",
      limit: "unbounded",
    })).resolves.toEqual({ ok: false, code: "not_found" });
    expect(hidden.store.getKnowledgeBase).not.toHaveBeenCalled();
    expect(hidden.store.listKnowledgeDocuments).not.toHaveBeenCalled();

    const invalidScope = setup();
    await expect(invalidScope.service.list(
      viewer,
      "x".repeat(513),
      "base-1",
      {},
    )).resolves.toEqual({ ok: false, code: "not_found" });
    expect(invalidScope.store.getAccessibleProject).not.toHaveBeenCalled();
    expect(invalidScope.store.listKnowledgeDocuments).not.toHaveBeenCalled();

    const invalidCases = [
      [{ status: ["ready"] }, "status"],
      [{ status: "unknown" }, "status"],
      [{ origin: "recursive" }, "origin"],
      [{ limit: "1.5" }, "limit"],
      [{ limit: 0 }, "limit"],
      [{ limit: 501 }, "limit"],
    ] as const;
    for (const [input, field] of invalidCases) {
      const current = setup();
      await expect(current.service.list(viewer, "project-1", "base-1", input))
        .resolves.toEqual({ ok: false, code: "invalid", field });
      expect(current.store.listKnowledgeDocuments).not.toHaveBeenCalled();
    }
  });

  it("hides foreign document ancestry and authorizes status before retry", async () => {
    const missing = setup({ documentVisible: false });
    await expect(missing.service.status(viewer, "project-1", "base-1", "foreign"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    expect(missing.store.getKnowledgeDocumentProcessing).not.toHaveBeenCalled();

    const viewerSetup = setup();
    await expect(viewerSetup.service.retry(viewer, "project-1", "base-1", "document-1"))
      .resolves.toEqual({ ok: false, code: "forbidden" });
    expect(viewerSetup.store.getKnowledgeBase).not.toHaveBeenCalled();
    expect(viewerSetup.store.retryKnowledgeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("retries with a server-owned id and never returns that id", async () => {
    const { service, store } = setup();
    await expect(service.retry(developer, "project-1", "base-1", "document-1"))
      .resolves.toEqual({
        ok: true,
        value: { documentId: "document-1", jobState: "pending", enqueued: true },
      });
    expect(store.retryKnowledgeDocumentProcessing).toHaveBeenCalledWith({
      orgId: "org-1",
      projectId: "project-1",
      baseId: "base-1",
      documentId: "document-1",
      parseVersion: 1,
    }, "job-created", at);

    vi.mocked(store.retryKnowledgeDocumentProcessing).mockResolvedValueOnce({
      document: await store.getKnowledgeDocument("document-1", "base-1", "org-1", "project-1") as KnowledgeDocumentRecord,
      jobState: "running",
      enqueued: false,
    });
    await expect(service.retry(developer, "project-1", "base-1", "document-1"))
      .resolves.toEqual({
        ok: true,
        value: { documentId: "document-1", jobState: "running", enqueued: false },
      });
  });
});
