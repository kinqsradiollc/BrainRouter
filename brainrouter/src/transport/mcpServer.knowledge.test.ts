import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessibleProject: vi.fn(),
  listKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
  getKnowledgeBase: vi.fn(),
  enqueueKnowledgeDocument: vi.fn(),
  getKnowledgeDocument: vi.fn(),
  getKnowledgeDocumentProcessing: vi.fn(),
  retryKnowledgeDocumentProcessing: vi.fn(),
  searchKnowledgeChunksByText: vi.fn(),
  searchKnowledgeChunksByVector: vi.fn(),
  resolveKnowledgeEmbeddingProvider: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    knowledge: {
      getAccessibleProject: mocks.getAccessibleProject,
      listKnowledgeBases: mocks.listKnowledgeBases,
      createKnowledgeBase: mocks.createKnowledgeBase,
      getKnowledgeBase: mocks.getKnowledgeBase,
      enqueueKnowledgeDocument: mocks.enqueueKnowledgeDocument,
      getKnowledgeDocument: mocks.getKnowledgeDocument,
      getKnowledgeDocumentProcessing: mocks.getKnowledgeDocumentProcessing,
      retryKnowledgeDocumentProcessing: mocks.retryKnowledgeDocumentProcessing,
      searchKnowledgeChunksByText: mocks.searchKnowledgeChunksByText,
      searchKnowledgeChunksByVector: mocks.searchKnowledgeChunksByVector,
    },
    resolveKnowledgeEmbeddingProvider: mocks.resolveKnowledgeEmbeddingProvider,
  },
}));

import { Registry } from "../registry.js";
import { buildMcpServer } from "./mcpServer.js";

const timestamp = "2026-07-22T01:02:03.000Z";
const base = {
  baseId: "kb-1",
  orgId: "org-a",
  projectId: "project-a",
  name: "Project docs",
  description: "Reviewed project knowledge",
  createdBy: "developer-1",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const document = {
  documentId: "kdoc-1",
  baseId: "kb-1",
  orgId: "org-a",
  projectId: "project-a",
  title: "Architecture notes",
  sourceName: "notes.md",
  sourceFormat: "markdown" as const,
  contentText: "private persisted content",
  contentSha256: "private-content-hash",
  status: "queued" as const,
  statusMessage: null,
  parseVersion: 1,
  createdBy: "developer-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  readyAt: null,
};

function parseTextResult(result: unknown) {
  const content = (result as { content?: unknown })?.content as Array<{ text?: unknown }>;
  if (typeof content[0]?.text !== "string") throw new Error("Expected a text tool result");
  return JSON.parse(content[0].text) as unknown;
}

function docxBase64(text: string): string {
  const documentBody = text.split("\n").map((line) => {
    const escaped = line
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&apos;");
    return `<w:p><w:r><w:t>${escaped}</w:t></w:r></w:p>`;
  }).join("");
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/word/document.xml"
          ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
          Target="word/document.xml"/>
      </Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>${documentBody}</w:body>
      </w:document>`),
  }, { level: 6 })).toString("base64");
}

describe("authenticated knowledge MCP tools", () => {
  const connections: Array<{ client: Client; server: ReturnType<typeof buildMcpServer> }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessibleProject.mockImplementation(async (projectId: string, orgId: string) => (
      projectId === "project-a" && orgId === "org-a"
        ? {
            projectId: "project-a",
            orgId: "org-a",
            name: "Project A",
            slug: "project-a",
            repoUrl: null,
            restricted: false,
            createdBy: "developer-1",
            createdAt: timestamp,
          }
        : null
    ));
    mocks.listKnowledgeBases.mockResolvedValue([base]);
    mocks.createKnowledgeBase.mockResolvedValue(undefined);
    mocks.getKnowledgeBase.mockResolvedValue(base);
    mocks.enqueueKnowledgeDocument.mockResolvedValue({
      document,
      created: true,
      jobId: "kjob-private",
    });
    mocks.getKnowledgeDocument.mockResolvedValue(document);
    mocks.getKnowledgeDocumentProcessing.mockResolvedValue({
      document,
      jobState: "pending",
      attempts: 0,
      maxAttempts: 3,
      chunkCount: 0,
      embeddingCount: 0,
    });
    mocks.retryKnowledgeDocumentProcessing.mockResolvedValue({
      document,
      jobState: "pending",
      enqueued: true,
      jobId: "kjob-retry-private",
    });
    const searchHit = {
      chunkId: "chunk-1",
      documentId: "kdoc-1",
      baseId: "kb-1",
      orgId: "org-a",
      projectId: "project-a",
      documentTitle: "Architecture notes",
      sourceName: "notes.md",
      ordinal: 0,
      content: "Rotate the signing key before deployment.",
      tokenCount: 7,
      charStart: 0,
      charEnd: 40,
      locator: { section: "Deployment", absolutePath: "/private/notes.md" },
    };
    mocks.searchKnowledgeChunksByText.mockResolvedValue([{ ...searchHit, textRank: 0.8 }]);
    mocks.searchKnowledgeChunksByVector.mockResolvedValue([{ ...searchHit, vectorScore: 0.9 }]);
    mocks.resolveKnowledgeEmbeddingProvider.mockResolvedValue({
      model: "search-model",
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
    });
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
  });

  async function connect(options: Parameters<typeof buildMcpServer>[1]) {
    const registry = new Registry({ globalRoot: "/nonexistent", localRoot: "/nonexistent" });
    const server = buildMcpServer(registry, options);
    const client = new Client({ name: "knowledge-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }

  it("does not advertise or execute knowledge tools without complete trusted tenant context", async () => {
    const client = await connect({ defaultUserId: "developer-1" });
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_list");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_base_create");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_ingest");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_ingest_docx");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_ingest_pdf");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_status");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_retry");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_search");
    await expect(client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-a", orgId: "org-a", role: "owner" },
    })).rejects.toThrow("Authenticated organization context required");
    await expect(client.callTool({
      name: "knowledge_search",
      arguments: { projectId: "project-a", query: "signing key" },
    })).rejects.toThrow("Authenticated organization context required");
    await expect(client.callTool({
      name: "knowledge_ingest_docx",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Unscoped DOCX",
        contentBase64: docxBase64("Private"),
      },
    })).rejects.toThrow("Authenticated organization context required");
    await expect(client.callTool({
      name: "knowledge_ingest_pdf",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Unscoped PDF",
        contentBase64: "JVBERi0xLjQ=",
      },
    })).rejects.toThrow("Authenticated organization context required");
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled();
  });

  it("lists bases with the session-pinned actor and omits custody identities", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const tools = await client.listTools();
    const result = await client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-a", orgId: "org-foreign", userId: "attacker", role: "owner" },
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "knowledge_list",
      "knowledge_base_create",
      "knowledge_ingest",
      "knowledge_ingest_docx",
      "knowledge_ingest_pdf",
      "knowledge_status",
      "knowledge_retry",
      "knowledge_search",
    ]));
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "developer-1",
      false,
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      bases: [{
        baseId: "kb-1",
        projectId: "project-a",
        name: "Project docs",
        description: "Reviewed project knowledge",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("developer-1");
    expect(JSON.stringify(payload)).not.toContain("org-a");
  });

  it("creates with server identity and rejects viewer role spoofing", async () => {
    const developer = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const created = await developer.callTool({
      name: "knowledge_base_create",
      arguments: {
        projectId: "project-a",
        name: "Project docs",
        description: "Reviewed project knowledge",
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
      },
    });

    expect(created.isError).not.toBe(true);
    expect(mocks.createKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      projectId: "project-a",
      createdBy: "developer-1",
      name: "Project docs",
    }));

    const viewer = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const denied = await viewer.callTool({
      name: "knowledge_base_create",
      arguments: { projectId: "project-a", name: "Escalation", role: "owner", isSystemAdmin: true },
    });

    expect(denied.isError).toBe(true);
    expect(parseTextResult(denied)).toEqual({
      error: { code: "forbidden" },
    });
    expect(mocks.createKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it("ingests with the session actor and returns no content, custody, hash, or queue id", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Architecture notes",
        sourceName: "notes.md",
        sourceFormat: "markdown",
        content: "Persist this project guidance",
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
        jobId: "kjob-attacker",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "developer-1",
      false,
    );
    expect(mocks.getKnowledgeBase).toHaveBeenCalledWith("kb-1", "org-a", "project-a");
    expect(mocks.enqueueKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        baseId: "kb-1",
        orgId: "org-a",
        projectId: "project-a",
        createdBy: "developer-1",
        title: "Architecture notes",
        sourceName: "notes.md",
        sourceFormat: "markdown",
        contentText: "Persist this project guidance",
      }),
      expect.stringMatching(/^kjob_/),
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      document: {
        documentId: "kdoc-1",
        title: "Architecture notes",
        sourceName: "notes.md",
        sourceFormat: "markdown",
        status: "queued",
        statusMessage: null,
        parseVersion: 1,
        updatedAt: timestamp,
        readyAt: null,
      },
      created: true,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("private persisted content");
    expect(serialized).not.toContain("private-content-hash");
    expect(serialized).not.toContain("developer-1");
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("kjob-private");
  });

  it("ingests a PDF with the session actor while keeping binary content and queue ids private", async () => {
    const contentBase64 = Buffer.from(
      "%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (Deployment\\nSECRET_TOKEN=abc123) Tj ET\n%%EOF",
      "latin1",
    ).toString("base64");
    mocks.enqueueKnowledgeDocument.mockImplementationOnce(async (record, jobId) => ({
      document: record,
      created: true,
      jobId,
    }));
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest_pdf",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Deployment guide",
        sourceName: "deployment.pdf",
        contentBase64,
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
        jobId: "kjob-attacker",
        path: "/private/deployment.pdf",
        url: "https://attacker.invalid/deployment.pdf",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "developer-1",
      false,
    );
    expect(mocks.enqueueKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        baseId: "kb-1",
        orgId: "org-a",
        projectId: "project-a",
        createdBy: "developer-1",
        title: "Deployment guide",
        sourceName: "deployment.pdf",
        sourceFormat: "pdf",
        contentText: "Deployment\n[REDACTED]",
      }),
      expect.stringMatching(/^kjob_/),
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      document: {
        documentId: expect.stringMatching(/^kdoc_/),
        title: "Deployment guide",
        sourceName: "deployment.pdf",
        sourceFormat: "pdf",
        status: "queued",
        statusMessage: null,
        parseVersion: 1,
        updatedAt: expect.any(String),
        readyAt: null,
      },
      created: true,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(contentBase64);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("developer-1");
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("kjob_");
    expect(serialized).not.toContain("/private/deployment.pdf");
    expect(serialized).not.toContain("attacker.invalid");
  });

  it("ingests a DOCX with the session actor while keeping package content and queue ids private", async () => {
    const contentBase64 = docxBase64("Deployment\nSECRET_TOKEN=abc123");
    mocks.enqueueKnowledgeDocument.mockImplementationOnce(async (record, jobId) => ({
      document: record,
      created: true,
      jobId,
    }));
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest_docx",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Deployment guide",
        sourceName: "deployment.docx",
        contentBase64,
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
        jobId: "kjob-attacker",
        path: "/private/deployment.docx",
        url: "https://attacker.invalid/deployment.docx",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "developer-1",
      false,
    );
    expect(mocks.enqueueKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        baseId: "kb-1",
        orgId: "org-a",
        projectId: "project-a",
        createdBy: "developer-1",
        title: "Deployment guide",
        sourceName: "deployment.docx",
        sourceFormat: "docx",
        contentText: "Deployment\n[REDACTED]",
      }),
      expect.stringMatching(/^kjob_/),
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      document: {
        documentId: expect.stringMatching(/^kdoc_/),
        title: "Deployment guide",
        sourceName: "deployment.docx",
        sourceFormat: "docx",
        status: "queued",
        statusMessage: null,
        parseVersion: 1,
        updatedAt: expect.any(String),
        readyAt: null,
      },
      created: true,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(contentBase64);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("developer-1");
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("kjob_");
    expect(serialized).not.toContain("/private/deployment.docx");
    expect(serialized).not.toContain("attacker.invalid");
  });

  it("returns exact-scope content-free status to readers", async () => {
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const result = await client.callTool({
      name: "knowledge_status",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        documentId: "kdoc-1",
        orgId: "org-foreign",
        userId: "attacker",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getKnowledgeDocument).toHaveBeenCalledWith(
      "kdoc-1",
      "kb-1",
      "org-a",
      "project-a",
    );
    expect(mocks.getKnowledgeDocumentProcessing).toHaveBeenCalledWith({
      orgId: "org-a",
      projectId: "project-a",
      baseId: "kb-1",
      documentId: "kdoc-1",
      parseVersion: 1,
    });
    expect(parseTextResult(result)).toEqual({
      document: {
        documentId: "kdoc-1",
        title: "Architecture notes",
        sourceName: "notes.md",
        sourceFormat: "markdown",
        status: "queued",
        statusMessage: null,
        parseVersion: 1,
        updatedAt: timestamp,
        readyAt: null,
        processing: {
          jobState: "pending",
          attempts: 0,
          maxAttempts: 3,
          retryable: false,
          chunkCount: 0,
          embeddingCount: 0,
        },
      },
    });
  });

  it("retries only the exact document scope without accepting or returning a job id", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_retry",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        documentId: "kdoc-1",
        jobId: "kjob-attacker",
        orgId: "org-foreign",
        userId: "attacker",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.retryKnowledgeDocumentProcessing).toHaveBeenCalledWith({
      orgId: "org-a",
      projectId: "project-a",
      baseId: "kb-1",
      documentId: "kdoc-1",
      parseVersion: 1,
    }, expect.stringMatching(/^kjob_/), expect.any(String));
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      retry: {
        documentId: "kdoc-1",
        jobState: "pending",
        enqueued: true,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("kjob-retry-private");
    expect(JSON.stringify(payload)).not.toContain("kjob-attacker");
  });

  it("allows viewer status reads but rejects text/PDF/DOCX ingest and retry role spoofing", async () => {
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const ingest = await client.callTool({
      name: "knowledge_ingest",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Escalation",
        sourceFormat: "text",
        content: "Should not persist",
        role: "owner",
        isSystemAdmin: true,
      },
    });
    const retry = await client.callTool({
      name: "knowledge_retry",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        documentId: "kdoc-1",
        role: "owner",
        isSystemAdmin: true,
      },
    });
    const pdf = await client.callTool({
      name: "knowledge_ingest_pdf",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Escalation PDF",
        contentBase64: Buffer.from("%PDF-1.4\nBT (Should not persist) Tj ET\n%%EOF", "latin1")
          .toString("base64"),
      },
    });
    const docx = await client.callTool({
      name: "knowledge_ingest_docx",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Escalation DOCX",
        contentBase64: docxBase64("Should not persist"),
      },
    });

    expect(ingest.isError).toBe(true);
    expect(parseTextResult(ingest)).toEqual({ error: { code: "forbidden" } });
    expect(pdf.isError).toBe(true);
    expect(parseTextResult(pdf)).toEqual({ error: { code: "forbidden" } });
    expect(docx.isError).toBe(true);
    expect(parseTextResult(docx)).toEqual({ error: { code: "forbidden" } });
    expect(retry.isError).toBe(true);
    expect(parseTextResult(retry)).toEqual({ error: { code: "forbidden" } });
    expect(mocks.enqueueKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.retryKnowledgeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("rejects malformed PDF payloads without persisting attacker content", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest_pdf",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Invalid PDF",
        contentBase64: "file:///private/runbook.pdf",
      },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({
      error: { code: "invalid", field: "contentBase64" },
    });
    expect(mocks.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("rejects malformed DOCX payloads without persisting attacker content", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest_docx",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Invalid DOCX",
        contentBase64: "file:///private/runbook.docx",
      },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({
      error: { code: "invalid", field: "contentBase64" },
    });
    expect(mocks.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("returns not found before processing an inaccessible document ancestry", async () => {
    mocks.getKnowledgeDocument.mockResolvedValueOnce(null);
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_status",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        documentId: "kdoc-foreign",
      },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({ error: { code: "not_found" } });
    expect(mocks.getKnowledgeDocumentProcessing).not.toHaveBeenCalled();
  });

  it("rejects malformed document input before persistence", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });

    await expect(client.callTool({
      name: "knowledge_ingest",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Architecture notes",
        sourceFormat: "pdf",
        content: "Unsupported format",
      },
    })).rejects.toThrow("Invalid arguments");
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled();
    expect(mocks.enqueueKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("accepts inline HTML but persists only extracted and redacted text", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });

    const result = await client.callTool({
      name: "knowledge_ingest",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Deployment page",
        sourceName: "deployment.html",
        sourceFormat: "html",
        content: "<h1>Deployment</h1><script>private()</script><p>SECRET_TOKEN=abc123</p>",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.enqueueKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFormat: "html",
        contentText: "Deployment\n[REDACTED]",
      }),
      expect.stringMatching(/^kjob_/),
    );
    expect(JSON.stringify(mocks.enqueueKnowledgeDocument.mock.calls[0]?.[0]))
      .not.toMatch(/<script|private\(\)|abc123/);
  });

  it("sanitizes unexpected persistence failures", async () => {
    mocks.enqueueKnowledgeDocument.mockRejectedValueOnce(new Error("database credential detail"));
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_ingest",
      arguments: {
        projectId: "project-a",
        baseId: "kb-1",
        title: "Architecture notes",
        sourceFormat: "text",
        content: "Valid content",
      },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({ error: { code: "internal_error" } });
    expect(JSON.stringify(parseTextResult(result))).not.toContain("credential");
  });

  it("returns the same not-found result for inaccessible Projects", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-foreign" },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({
      error: { code: "not_found" },
    });
    expect(mocks.listKnowledgeBases).not.toHaveBeenCalled();
  });

  it("searches with the session actor and returns citation-safe hybrid results", async () => {
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const result = await client.callTool({
      name: "knowledge_search",
      arguments: {
        projectId: "project-a",
        query: "signing key",
        baseIds: ["kb-1"],
        limit: 5,
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        embedding: [9, 9, 9],
        embeddingModel: "attacker-model",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "viewer-1",
      false,
    );
    expect(mocks.listKnowledgeBases).toHaveBeenCalledWith("org-a", "project-a");
    expect(mocks.searchKnowledgeChunksByText).toHaveBeenCalledWith({
      orgId: "org-a",
      projectId: "project-a",
      baseIds: ["kb-1"],
      limit: 20,
    }, "signing key");
    expect(mocks.resolveKnowledgeEmbeddingProvider).toHaveBeenCalledWith("org-a");
    expect(mocks.searchKnowledgeChunksByVector).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", projectId: "project-a", baseIds: ["kb-1"] }),
      { embeddingModel: "search-model", dimensions: 3, embedding: expect.any(Float32Array) },
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      search: {
        mode: "hybrid",
        hits: [{
          content: "Rotate the signing key before deployment.",
          score: 2 / 61,
          matchedBy: ["lexical", "vector"],
          citation: {
            projectId: "project-a",
            baseId: "kb-1",
            documentId: "kdoc-1",
            chunkId: "chunk-1",
            documentTitle: "Architecture notes",
            sourceName: "notes.md",
            ordinal: 0,
            charStart: 0,
            charEnd: 40,
            locator: { section: "Deployment" },
          },
        }],
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("viewer-1");
    expect(serialized).not.toContain("attacker-model");
    expect(serialized).not.toContain("absolutePath");
  });

  it("falls back to lexical search without exposing embedding provider failures", async () => {
    mocks.resolveKnowledgeEmbeddingProvider.mockRejectedValueOnce(
      new Error("private provider credential detail"),
    );
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const result = await client.callTool({
      name: "knowledge_search",
      arguments: { projectId: "project-a", query: "signing key" },
    });

    expect(result.isError).not.toBe(true);
    expect(parseTextResult(result)).toMatchObject({ search: { mode: "lexical" } });
    expect(mocks.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
    expect(JSON.stringify(parseTextResult(result))).not.toContain("credential");
  });

  it("validates search input and base ancestry before retrieval", async () => {
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    await expect(client.callTool({
      name: "knowledge_search",
      arguments: { projectId: "project-a", query: "" },
    })).rejects.toThrow("Invalid arguments");

    const foreignBase = await client.callTool({
      name: "knowledge_search",
      arguments: {
        projectId: "project-a",
        query: "signing key",
        baseIds: ["kb-foreign"],
      },
    });
    expect(foreignBase.isError).toBe(true);
    expect(parseTextResult(foreignBase)).toEqual({ error: { code: "not_found" } });
    expect(mocks.searchKnowledgeChunksByText).not.toHaveBeenCalled();
    expect(mocks.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected search persistence failures", async () => {
    mocks.searchKnowledgeChunksByText.mockRejectedValueOnce(
      new Error("private database credential detail"),
    );
    const client = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const result = await client.callTool({
      name: "knowledge_search",
      arguments: { projectId: "project-a", query: "signing key" },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({ error: { code: "internal_error" } });
    expect(JSON.stringify(parseTextResult(result))).not.toContain("credential");
  });
});
