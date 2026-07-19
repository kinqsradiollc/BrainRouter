/**
 * GET /api/admin/providers inheritance — an org with no BYOK provider of its own
 * is shown the system/deployment org's configs READ-ONLY (never a blank page on
 * org switch), while the system org itself never self-inherits. Mirrors the
 * managed-model inheritance in catalog.test.ts.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
  listProviderConfigs: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_admin" ? { userId: "admin-1", isAdmin: false, email: "admin@example.test" } : null,
    ),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: vi.fn(),
    },
    providers: { listProviderConfigs: mocks.listProviderConfigs },
  },
}));

vi.mock("../../../security/secretBox.js", () => ({ isSecretBoxConfigured: () => true }));

import { providersRouter } from "./providers.js";

type HttpResult = { status: number; body: any };
function requestJson(url: URL, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-a", orgId: "org-a", kind: "llm", providerId: "openai", label: "OpenAI",
    baseUrl: "https://api.openai.com/v1", model: "gpt-5", models: [], wireFormat: "",
    reasoningEffort: "", enabled: true, isDefault: true, hasKey: true, ...overrides,
  };
}

describe("GET /api/admin/providers inheritance", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";
  const adminHeaders = { Authorization: "Bearer br_admin", "X-BrainRouter-Org": "org-a" };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      orgId === "org-a" && userId === "admin-1" ? "admin" : null,
    );
    const app = express();
    app.use(express.json());
    app.use("/api/admin/providers", providersRouter);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, (e?: Error) => (e ? reject(e) : resolve()));
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    server = undefined;
  });

  it("returns the org's own configs (not inherited) when it has them", async () => {
    mocks.listProviderConfigs.mockResolvedValue([config()]);
    const res = await requestJson(new URL(`${baseUrl}/api/admin/providers`), adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.inherited).toBe(false);
    expect(res.body.source.orgId).toBe("org-a");
    expect(res.body.providers.every((p: { readOnly?: boolean }) => !p.readOnly)).toBe(true);
  });

  it("inherits the deployment default read-only when the org has none of its own", async () => {
    mocks.listProviderConfigs.mockImplementation(async (orgId: string) =>
      orgId === "org_personal_admin" ? [config({ orgId: "org_personal_admin", id: "sys-cfg" })] : [],
    );
    const res = await requestJson(new URL(`${baseUrl}/api/admin/providers`), adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.inherited).toBe(true);
    expect(res.body.source.orgId).toBe("org_personal_admin");
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0].readOnly).toBe(true);
    // never leaks a key
    expect(JSON.stringify(res.body)).not.toContain("apiKey");
    expect(JSON.stringify(res.body)).not.toContain("ciphertext");
  });

  it("never self-inherits when the caller IS the system org", async () => {
    process.env.BRAINROUTER_SYSTEM_ORG_ID = "org-a";
    try {
      mocks.listProviderConfigs.mockResolvedValue([]);
      const res = await requestJson(new URL(`${baseUrl}/api/admin/providers`), adminHeaders);
      expect(res.status).toBe(200);
      expect(res.body.inherited).toBe(false);
      expect(res.body.providers).toHaveLength(0);
      expect(res.body.source.isSystemOrg).toBe(true);
    } finally {
      delete process.env.BRAINROUTER_SYSTEM_ORG_ID;
    }
  });
});
