import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  recall: vi.fn(),
  capture: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  listAccessibleProjects: vi.fn(),
  getDefaultResolvedProvider: vi.fn(),
  getSourceDocuments: vi.fn(),
  getSourceDocument: vi.fn(),
  getSourceChunksByDocument: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => key === "br_user"
      ? { userId: "user-1", isAdmin: false, email: "user@example.test", status: "active" }
      : null),
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: vi.fn(async () => ({ orgId: "org-1" })),
    },
    projects: {
      listAccessibleProjects: mocks.listAccessibleProjects,
    },
    providers: {
      getDefaultResolvedProvider: mocks.getDefaultResolvedProvider,
    },
    recall: mocks.recall,
    capture: mocks.capture,
    store: {
      getSourceDocuments: mocks.getSourceDocuments,
      getSourceDocument: mocks.getSourceDocument,
      getSourceChunksByDocument: mocks.getSourceChunksByDocument,
    },
  },
}));

vi.mock("../services/modelGateway/modelGateway.js", () => ({
  modelGateway: { dispatch: mocks.dispatch },
}));

import { brainRouter } from "../api/routes/agent/brain.js";

const provider = {
  kind: "llm" as const,
  endpoint: "https://models.example/v1",
  apiKey: "sealed-key",
  model: "model-a",
  models: [],
  extra: {},
  source: "db" as const,
};

describe("scoped brain API routes", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      orgId === "org-1" && userId === "user-1" ? "developer" : null);
    mocks.getDefaultOrgId.mockResolvedValue("org-1");
    mocks.listAccessibleProjects.mockResolvedValue([{
      projectId: "project-1",
      orgId: "org-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: null,
      restricted: false,
      createdBy: "user-1",
      createdAt: "2026-07-13T00:00:00.000Z",
    }]);
    mocks.getDefaultResolvedProvider.mockResolvedValue(provider);
    mocks.recall.mockResolvedValue({
      recallStrategy: "hybrid",
      recalledCognitiveMemories: [],
    });
    mocks.dispatch.mockResolvedValue("Scoped answer");
    mocks.capture.mockResolvedValue({ sensoryRecordedCount: 2 });
    mocks.getSourceDocuments.mockResolvedValue([]);
    mocks.getSourceDocument.mockResolvedValue(null);
    mocks.getSourceChunksByDocument.mockResolvedValue([]);

    const app = express();
    app.use(express.json());
    app.use("/api/brain", brainRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/brain/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  const validBody = {
    messages: [{ role: "user", content: "What should I work on next?" }],
    sessionKey: "dashboard-chat-1",
    projectId: "project-1",
    workspaceTag: "workspace-1",
  };

  it("rejects an unauthenticated request before model dispatch", async () => {
    const response = await post(validBody);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects invalid history before model dispatch", async () => {
    const response = await post({
      ...validBody,
      messages: [{ role: "assistant", content: "This cannot be the latest turn." }],
    }, { Authorization: "Bearer br_user", "X-BrainRouter-Org": "org-1" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "bad_request" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("denies a requested organization the caller does not belong to", async () => {
    const response = await post(validBody, {
      Authorization: "Bearer br_user",
      "X-BrainRouter-Org": "org-other",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("denies a project outside the caller's accessible project set", async () => {
    mocks.listAccessibleProjects.mockResolvedValue([]);

    const response = await post(validBody, {
      Authorization: "Bearer br_user",
      "X-BrainRouter-Org": "org-1",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("returns the scoped chat contract", async () => {
    const response = await post(validBody, {
      Authorization: "Bearer br_user",
      "X-BrainRouter-Org": "org-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: { role: "assistant", content: "Scoped answer" },
      citations: [],
      recallStrategy: "hybrid",
    });
    expect(mocks.getDefaultResolvedProvider).toHaveBeenCalledWith("org-1", "llm");
    expect(mocks.recall).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      filters: expect.objectContaining({ orgId: "org-1", callerUserId: "user-1" }),
    }));
  });

  it("does not expose a provider response body when dispatch fails", async () => {
    mocks.dispatch.mockRejectedValue(new Error(
      '[dashboard-chat] 400 Bad Request — {"error":{"message":"secret vendor trace"}}',
    ));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post(validBody, {
      Authorization: "Bearer br_user",
      "X-BrainRouter-Org": "org-1",
    });
    const body = await response.json() as { error: string; code: string };

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "Chat request failed. Check the active model provider and try again.",
      code: "internal_error",
    });
    expect(JSON.stringify(body)).not.toContain("secret vendor trace");
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("lists sources only with the active org/project/workspace filters", async () => {
    mocks.getSourceDocuments.mockResolvedValue([{ id: "source-1", userId: "user-1", orgId: "org-1" }]);

    const response = await fetch(
      `${baseUrl}/api/brain/sources?projectId=project-1&workspaceTag=workspace-1&limit=25`,
      { headers: { Authorization: "Bearer br_user", "X-BrainRouter-Org": "org-1" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      documents: [{ id: "source-1", userId: "user-1", orgId: "org-1" }],
    });
    expect(mocks.getSourceDocuments).toHaveBeenCalledWith("user-1", 25, {
      orgId: "org-1",
      projectId: "project-1",
      workspaceTag: "workspace-1",
      includeUnscoped: false,
    });
  });

  it("does not return chunks from a source in another organization", async () => {
    mocks.getSourceDocument.mockResolvedValue({
      id: "source-other",
      userId: "user-1",
      orgId: "org-other",
      projectId: null,
    });

    const response = await fetch(`${baseUrl}/api/brain/sources/source-other/chunks`, {
      headers: { Authorization: "Bearer br_user", "X-BrainRouter-Org": "org-1" },
    });

    expect(response.status).toBe(404);
    expect(mocks.getSourceChunksByDocument).not.toHaveBeenCalled();
  });

  it("does not expose database diagnostics when source listing fails", async () => {
    mocks.getSourceDocuments.mockRejectedValue(new Error("relation source_documents_internal does not exist"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await fetch(`${baseUrl}/api/brain/sources`, {
      headers: { Authorization: "Bearer br_user", "X-BrainRouter-Org": "org-1" },
    });
    const body = await response.json() as { error: string; code: string };

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Could not load sources", code: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("source_documents_internal");
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("does not expose database diagnostics when source chunk loading fails", async () => {
    mocks.getSourceDocument.mockResolvedValue({
      id: "source-1",
      userId: "user-1",
      orgId: "org-1",
      projectId: null,
    });
    mocks.getSourceChunksByDocument.mockRejectedValue(new Error("column source_chunks.secret_internal is missing"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await fetch(`${baseUrl}/api/brain/sources/source-1/chunks`, {
      headers: { Authorization: "Bearer br_user", "X-BrainRouter-Org": "org-1" },
    });
    const body = await response.json() as { error: string; code: string };

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Could not load source chunks", code: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("secret_internal");
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
