import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelRecord } from "../../../providers/modelPolicyStore.js";

const mocks = vi.hoisted(() => ({
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
  listProviderModels: vi.fn(),
  getProviderModel: vi.fn(),
  createProviderModel: vi.fn(),
  updateProviderModel: vi.fn(),
  deleteProviderModel: vi.fn(),
  setDefaultProviderModel: vi.fn(),
  reorderProviderModels: vi.fn(),
  getProviderConfig: vi.fn(),
  getResolvedProvider: vi.fn(),
  probeModels: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => {
      if (key === "br_viewer") return { userId: "viewer-1", isAdmin: false, email: "viewer@example.test" };
      if (key === "br_admin") return { userId: "admin-1", isAdmin: false, email: "admin@example.test" };
      return null;
    }),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: vi.fn(),
    },
    models: {
      listProviderModels: mocks.listProviderModels,
      getProviderModel: mocks.getProviderModel,
      createProviderModel: mocks.createProviderModel,
      updateProviderModel: mocks.updateProviderModel,
      deleteProviderModel: mocks.deleteProviderModel,
      setDefaultProviderModel: mocks.setDefaultProviderModel,
      reorderProviderModels: mocks.reorderProviderModels,
    },
    providers: {
      getProviderConfig: mocks.getProviderConfig,
      getResolvedProvider: mocks.getResolvedProvider,
    },
  },
}));

vi.mock("../../../providers/modelProbe.js", () => ({ probeModels: mocks.probeModels }));

import { adminModelsRouter } from "../admin/models.js";
import { modelsRouter } from "./catalog.js";

type HttpResult = { status: number; body: unknown; headers: Record<string, string | string[] | undefined> };

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
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) : null,
          headers: res.headers,
        });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

const timestamp = "2026-07-14T01:02:03.000Z";
function model(overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord {
  return {
    id: "model-a",
    orgId: "org-a",
    providerConfigId: "provider-a",
    publicModelId: "gpt-5.6-sol",
    upstreamModelId: "custody-only-upstream-id",
    displayName: "GPT-5.6 Sol",
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    allowedEfforts: ["none", "high"],
    defaultEffort: "high",
    effortWireMap: {
      none: { "reasoning.effort": "none" },
      high: { "reasoning.effort": "high" },
    },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "verified",
    sourceUrl: "https://provider.example/models",
    verifiedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("server-managed model APIs", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId !== "org-a") return null;
      if (userId === "admin-1") return "admin";
      if (userId === "viewer-1") return "viewer";
      return null;
    });
    mocks.listProviderModels.mockResolvedValue([model()]);
    mocks.getProviderModel.mockResolvedValue(model());
    mocks.createProviderModel.mockImplementation(async (_orgId: string, input: Record<string, unknown>) => model(input));
    mocks.updateProviderModel.mockImplementation(async (_orgId: string, _id: string, patch: Record<string, unknown>) => model(patch));
    mocks.deleteProviderModel.mockResolvedValue(true);
    mocks.setDefaultProviderModel.mockResolvedValue(true);
    mocks.reorderProviderModels.mockResolvedValue(undefined);
    mocks.getProviderConfig.mockResolvedValue({ id: "provider-a", orgId: "org-a", kind: "llm" });
    mocks.getResolvedProvider.mockResolvedValue({ endpoint: "https://upstream.example/v1", apiKey: "provider-secret" });
    mocks.probeModels.mockResolvedValue([{ id: "model-one" }, { id: "model-two" }]);

    const app = express();
    app.use(express.json());
    app.use("/api/models", modelsRouter);
    app.use("/api/admin/models", adminModelsRouter);
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

  const viewerHeaders = { Authorization: "Bearer br_viewer", "X-BrainRouter-Org": "org-a" };
  const adminHeaders = { Authorization: "Bearer br_admin", "X-BrainRouter-Org": "org-a" };

  it("rejects unauthenticated and cross-organization catalog reads", async () => {
    const unauthenticated = await requestJson(new URL(`${baseUrl}/api/models/catalog`), "GET");
    const crossOrg = await requestJson(new URL(`${baseUrl}/api/models/catalog`), "GET", {
      Authorization: "Bearer br_viewer",
      "X-BrainRouter-Org": "org-b",
    });

    expect(unauthenticated.status).toBe(401);
    expect(crossOrg.status).toBe(403);
    expect(mocks.listProviderModels).not.toHaveBeenCalled();
  });

  it("returns a revisioned, cacheable member catalog with no custody identifiers", async () => {
    const first = await requestJson(new URL(`${baseUrl}/api/models/catalog`), "GET", viewerHeaders);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      revision: expect.stringMatching(/^catalog:/),
      models: [{ id: "gpt-5.6-sol", provider: "brainrouter" }],
    });
    expect(mocks.listProviderModels).toHaveBeenCalledWith("org-a", true);
    expect(JSON.stringify(first.body)).not.toContain("provider-a");
    expect(JSON.stringify(first.body)).not.toContain("custody-only-upstream-id");

    const etag = String(first.headers.etag);
    const cached = await requestJson(new URL(`${baseUrl}/api/models/catalog`), "GET", {
      ...viewerHeaders,
      "If-None-Match": etag,
    });
    expect(cached.status).toBe(304);
    expect(cached.body).toBeNull();
  });

  it("keeps management admin-only and validates exact effort invariants", async () => {
    const forbidden = await requestJson(new URL(`${baseUrl}/api/admin/models`), "GET", viewerHeaders);
    const invalid = await requestJson(new URL(`${baseUrl}/api/admin/models`), "POST", adminHeaders, {
      providerConfigId: "provider-a",
      publicModelId: "gpt-5.6-sol",
      upstreamModelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      allowedEfforts: ["low"],
      defaultEffort: "max",
      effortWireMap: { low: { "reasoning.effort": "low" } },
      capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
      capabilitySource: "manual",
    });

    expect(forbidden.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain("defaultEffort must be one of allowedEfforts");
    expect(mocks.createProviderModel).not.toHaveBeenCalled();
  });

  it("creates the first enabled model as an explicit organization default", async () => {
    mocks.listProviderModels.mockResolvedValue([]);
    const response = await requestJson(new URL(`${baseUrl}/api/admin/models`), "POST", adminHeaders, {
      providerConfigId: "provider-a",
      publicModelId: "model-one",
      upstreamModelId: "upstream-one",
      displayName: "Model One",
      allowedEfforts: [],
      defaultEffort: null,
      effortWireMap: {},
      capabilities: { streaming: true, tools: true, responses: false, reasoning: false },
      capabilitySource: "discovered",
    });

    expect(response.status).toBe(201);
    expect(mocks.createProviderModel).toHaveBeenCalledWith("org-a", expect.objectContaining({
      publicModelId: "model-one",
      isDefault: true,
    }));
  });

  it("scopes provider discovery and never returns the provider credential", async () => {
    const response = await requestJson(new URL(`${baseUrl}/api/admin/models/discover`), "POST", adminHeaders, {
      providerConfigId: "provider-a",
    });

    expect(response.status).toBe(200);
    // The trailing policy argument is the SSRF boundary, not incidental: an
    // admin-supplied endpoint reaches `fetch` through it, and `{}` means the
    // fail-closed hosted mode. Asserted explicitly so dropping it is a test
    // failure rather than a silent reopening of the hole.
    expect(mocks.probeModels).toHaveBeenCalledWith(
      "https://upstream.example/v1",
      "provider-secret",
      "llm",
      8000,
      {},
    );
    expect(response.body).toEqual({
      models: [{ id: "model-one" }, { id: "model-two" }],
      selection: { mode: "explicit", upstreamModelIds: ["model-one", "model-two"] },
    });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret");

    mocks.getProviderConfig.mockResolvedValue({ id: "provider-a", orgId: "org-b", kind: "llm" });
    const crossOrg = await requestJson(new URL(`${baseUrl}/api/admin/models/discover`), "POST", adminHeaders, {
      providerConfigId: "provider-a",
    });
    expect(crossOrg.status).toBe(404);
  });

  it("keeps default, delete, and ordering writes organization-scoped", async () => {
    const order = await requestJson(new URL(`${baseUrl}/api/admin/models/order`), "POST", adminHeaders, {
      modelIds: ["model-a"],
    });
    const makeDefault = await requestJson(
      new URL(`${baseUrl}/api/admin/models/model-a/default`),
      "POST",
      adminHeaders,
    );
    const deleteDefault = await requestJson(
      new URL(`${baseUrl}/api/admin/models/model-a`),
      "DELETE",
      adminHeaders,
    );

    expect(order.status).toBe(200);
    expect(mocks.reorderProviderModels).toHaveBeenCalledWith("org-a", ["model-a"]);
    expect(makeDefault.status).toBe(200);
    expect(mocks.setDefaultProviderModel).toHaveBeenCalledWith("org-a", "model-a");
    expect(deleteDefault.status).toBe(400);
    expect(mocks.deleteProviderModel).not.toHaveBeenCalled();
  });

  it("GET /api/admin/models returns the org's own set (not inherited) when it has enabled models", async () => {
    // default beforeEach mock returns [model()] (orgId org-a) for org-a
    const response = await requestJson(new URL(`${baseUrl}/api/admin/models`), "GET", adminHeaders);
    expect(response.status).toBe(200);
    const body = response.body as { models: Array<{ readOnly?: boolean }>; inherited: boolean; source: { orgId: string } };
    expect(body.inherited).toBe(false);
    expect(body.source.orgId).toBe("org-a");
    expect(body.models.every((m) => !m.readOnly)).toBe(true);
  });

  it("GET /api/admin/models inherits the deployment default read-only when the org has none of its own", async () => {
    // org-a has no models; the system org (org_personal_admin, the default) does.
    mocks.listProviderModels.mockImplementation(async (orgId: string) =>
      orgId === "org_personal_admin" ? [model({ id: "sys-model", orgId: "org_personal_admin" })] : [],
    );
    const response = await requestJson(new URL(`${baseUrl}/api/admin/models`), "GET", adminHeaders);
    expect(response.status).toBe(200);
    const body = response.body as { models: Array<{ id: string; orgId: string; readOnly?: boolean }>; inherited: boolean; source: { orgId: string; isSystemOrg: boolean } };
    expect(body.inherited).toBe(true);
    expect(body.source.orgId).toBe("org_personal_admin");
    expect(body.models).toHaveLength(1);
    expect(body.models[0].readOnly).toBe(true);
    expect(body.models[0].orgId).toBe("org_personal_admin");
    // it looked up the system org's ENABLED models
    expect(mocks.listProviderModels).toHaveBeenCalledWith("org_personal_admin", true);
  });

  it("GET /api/admin/models never self-inherits when the caller IS the system org", async () => {
    process.env.BRAINROUTER_SYSTEM_ORG_ID = "org-a";
    try {
      mocks.listProviderModels.mockResolvedValue([]);
      const response = await requestJson(new URL(`${baseUrl}/api/admin/models`), "GET", adminHeaders);
      expect(response.status).toBe(200);
      const body = response.body as { models: unknown[]; inherited: boolean; source: { isSystemOrg: boolean } };
      expect(body.inherited).toBe(false);
      expect(body.models).toHaveLength(0);
      expect(body.source.isSystemOrg).toBe(true);
    } finally {
      delete process.env.BRAINROUTER_SYSTEM_ORG_ID;
    }
  });
});
