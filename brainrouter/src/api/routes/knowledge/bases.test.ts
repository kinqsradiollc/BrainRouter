import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeActor } from "../../../knowledge/contracts/actor.js";
import type {
  CreateKnowledgeBaseInput,
  KnowledgeBaseRecord,
  KnowledgeServiceResult,
  UpdateKnowledgeBaseInput,
} from "../../../knowledge/contracts/base.js";

const mocks = vi.hoisted(() => ({
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
  ensurePersonalOrg: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => {
      if (key === "br_viewer") return { userId: "viewer-1", isAdmin: false, email: "viewer@example.test" };
      if (key === "br_developer") return { userId: "developer-1", isAdmin: false, email: "developer@example.test" };
      return null;
    }),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    knowledge: {},
  },
}));

import { createKnowledgeBasesRouter, type KnowledgeBaseOperations } from "./bases.js";

type HttpResult = { status: number; body: unknown };

function requestJson(
  url: URL,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest(url, {
      method,
      headers: encoded
        ? { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(encoded)) }
        : headers,
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

const timestamp = "2026-07-22T01:02:03.000Z";
function base(overrides: Partial<KnowledgeBaseRecord> = {}): KnowledgeBaseRecord {
  return {
    baseId: "kb-1",
    orgId: "org-a",
    projectId: "project-a",
    name: "Project docs",
    description: "Reviewed project knowledge",
    createdBy: "developer-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function ok<T>(value: T): KnowledgeServiceResult<T> {
  return { ok: true, value };
}

describe("knowledge base REST adapter", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";
  let service: KnowledgeBaseOperations;
  let list: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId !== "org-a") return null;
      if (userId === "viewer-1") return "viewer";
      if (userId === "developer-1") return "developer";
      return null;
    });

    list = vi.fn().mockResolvedValue(ok([base()]));
    get = vi.fn().mockResolvedValue(ok(base()));
    create = vi.fn().mockResolvedValue(ok(base()));
    update = vi.fn().mockResolvedValue(ok(base({ name: "Updated docs" })));
    remove = vi.fn().mockResolvedValue(ok(true));
    service = { list, get, create, update, delete: remove } as KnowledgeBaseOperations;

    const app = express();
    app.use(express.json());
    app.use("/api/knowledge", createKnowledgeBasesRouter(service));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, (error?: Error) => {
        if (error) reject(error); else resolve();
      });
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => {
        if (error) reject(error); else resolve();
      }));
    }
    server = undefined;
  });

  const developerHeaders = { Authorization: "Bearer br_developer", "X-BrainRouter-Org": "org-a" };

  it("rejects unauthenticated and cross-organization requests before the service", async () => {
    const unauthenticated = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "GET",
    );
    const foreignOrg = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "GET",
      { Authorization: "Bearer br_developer", "X-BrainRouter-Org": "org-b" },
    );

    expect(unauthenticated).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(foreignOrg).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(list).not.toHaveBeenCalled();
  });

  it("derives the actor from authentication and strips custody fields from writes and responses", async () => {
    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "POST",
      developerHeaders,
      {
        name: "Project docs",
        description: "Reviewed project knowledge",
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
        createdBy: "attacker",
      },
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      {
        userId: "developer-1",
        orgId: "org-a",
        role: "developer",
        isSystemAdmin: false,
      } satisfies KnowledgeActor,
      "project-a",
      {
        name: "Project docs",
        description: "Reviewed project knowledge",
      } satisfies CreateKnowledgeBaseInput,
    );
    expect(response.body).toEqual({
      base: {
        baseId: "kb-1",
        projectId: "project-a",
        name: "Project docs",
        description: "Reviewed project knowledge",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("org-a");
    expect(JSON.stringify(response.body)).not.toContain("developer-1");
  });

  it("does not let a viewer elevate a write role through the request body", async () => {
    create.mockImplementationOnce(async (actor: KnowledgeActor) => (
      actor.role === "viewer"
        ? { ok: false, code: "forbidden" }
        : ok(base())
    ));

    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "POST",
      { Authorization: "Bearer br_viewer", "X-BrainRouter-Org": "org-a" },
      { name: "Escalation attempt", role: "owner", isSystemAdmin: true },
    );

    expect(response).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "viewer-1", role: "viewer", isSystemAdmin: false }),
      "project-a",
      { name: "Escalation attempt", description: undefined },
    );
  });

  it("serves list, get, update, and delete through the scoped project path", async () => {
    const listed = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "GET",
      developerHeaders,
    );
    const loaded = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1`),
      "GET",
      developerHeaders,
    );
    const patched = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1`),
      "PATCH",
      developerHeaders,
      { name: "Updated docs", orgId: "org-foreign" },
    );
    const deleted = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1`),
      "DELETE",
      developerHeaders,
    );

    expect(listed).toMatchObject({ status: 200, body: { bases: [{ baseId: "kb-1" }] } });
    expect(loaded).toMatchObject({ status: 200, body: { base: { baseId: "kb-1" } } });
    expect(patched).toMatchObject({ status: 200, body: { base: { name: "Updated docs" } } });
    expect(deleted).toEqual({ status: 204, body: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", userId: "developer-1" }),
      "project-a",
      "kb-1",
      { name: "Updated docs", description: undefined } satisfies UpdateKnowledgeBaseInput,
    );
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", userId: "developer-1" }),
      "project-a",
      "kb-1",
    );
  });

  it.each([
    [{ ok: false, code: "not_found" }, 404, "not_found"],
    [{ ok: false, code: "forbidden" }, 403, "forbidden"],
    [{ ok: false, code: "invalid", field: "name" }, 400, "bad_request"],
    [{ ok: false, code: "conflict", field: "name" }, 409, "conflict"],
  ] as const)("maps the %s service result to a stable HTTP error", async (failure, status, code) => {
    list.mockResolvedValueOnce(failure);

    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases`),
      "GET",
      developerHeaders,
    );

    expect(response).toMatchObject({ status, body: { code } });
  });
});
