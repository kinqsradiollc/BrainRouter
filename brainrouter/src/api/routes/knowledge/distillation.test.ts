import express from "express";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentRecord } from "../../../knowledge/contracts/document.js";

const mocks = vi.hoisted(() => ({
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
  ensurePersonalOrg: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_developer"
        ? { userId: "developer-1", isAdmin: false, email: "developer@example.test" }
        : null),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    knowledge: {},
    modelRunner: vi.fn(),
  },
}));

import {
  createKnowledgeDistillationRouter,
  type KnowledgeDistillationOperations,
} from "./distillation.js";

type HttpResult = { status: number; body: unknown };

function requestJson(url: URL, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = httpRequest(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(encoded)),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

const at = "2026-07-26T00:00:00.000Z";
const derived: KnowledgeDocumentRecord = {
  documentId: "derived-1",
  baseId: "base-1",
  orgId: "org-a",
  projectId: "project-a",
  title: "Deployment model",
  sourceName: "Derived note",
  sourceFormat: "markdown",
  contentText: "Private generated content",
  contentSha256: "a".repeat(64),
  origin: "derived",
  distillationVersion: 1,
  status: "queued",
  statusMessage: null,
  parseVersion: 1,
  createdBy: "developer-1",
  createdAt: at,
  updatedAt: at,
  readyAt: null,
};

describe("knowledge distillation REST adapter", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let endpoint: URL;
  let distill: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getMemberRole.mockResolvedValue("developer");
    distill = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        documents: [{
          document: derived,
          sourceDocumentIds: ["source-1"],
          created: true,
          jobId: "private-job-id",
        }],
        sourceDocumentIds: ["source-1"],
        distillationVersion: 1,
      },
    });
    const service = { distill } as KnowledgeDistillationOperations;
    const app = express();
    app.use(express.json());
    app.use("/api/knowledge", createKnowledgeDistillationRouter(service));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, (error?: Error) => error ? reject(error) : resolve());
    });
    const { port } = server!.address() as AddressInfo;
    endpoint = new URL(
      `http://127.0.0.1:${port}/api/knowledge/projects/project-a/bases/base-1/distill`,
    );
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()));
    }
    server = undefined;
  });

  it("pins actor scope and returns content-free derived-document provenance", async () => {
    const response = await requestJson(endpoint, {
      Authorization: "Bearer br_developer",
      "X-BrainRouter-Org": "org-a",
    }, {
      confirmed: true,
      documentIds: ["source-1"],
      maxNotes: 3,
      orgId: "org-foreign",
      userId: "attacker",
      content: "caller-controlled output",
    });

    expect(response.status).toBe(202);
    expect(distill).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "developer-1",
        orgId: "org-a",
        role: "developer",
      }),
      "project-a",
      "base-1",
      {
        confirmed: true,
        documentIds: ["source-1"],
        maxNotes: 3,
      },
    );
    expect(response.body).toEqual({
      distillationVersion: 1,
      sourceDocumentIds: ["source-1"],
      documents: [{
        documentId: "derived-1",
        title: "Deployment model",
        sourceFormat: "markdown",
        origin: "derived",
        status: "queued",
        sourceDocumentIds: ["source-1"],
        created: true,
      }],
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("Private generated content");
    expect(serialized).not.toContain("private-job-id");
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("developer-1");
  });

  it("requires authentication and maps model unavailability without details", async () => {
    const unauthenticated = await requestJson(endpoint, {}, { confirmed: true });
    expect(unauthenticated.status).toBe(401);

    distill.mockResolvedValueOnce({ ok: false, code: "unavailable" });
    const unavailable = await requestJson(endpoint, {
      Authorization: "Bearer br_developer",
      "X-BrainRouter-Org": "org-a",
    }, { confirmed: true });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).toContain("distillation is unavailable");
    expect(JSON.stringify(unavailable.body)).not.toContain("provider");
  });
});
