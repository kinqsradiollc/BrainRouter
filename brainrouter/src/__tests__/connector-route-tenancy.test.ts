import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfigRecord } from "../connectors/store.js";

const mocks = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  getConnector: vi.fn(),
  getResolvedConnector: vi.fn(),
  createConnector: vi.fn(),
  updateConnector: vi.fn(),
  deleteConnector: vi.fn(),
  getResolvedOAuthApp: vi.fn(),
  upsertOAuthApp: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  runConnectorSync: vi.fn(),
  enqueueAgentJob: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => {
      if (key === "br_user") return { userId: "user-1", isAdmin: false, email: "user@example.test" };
      if (key === "br_admin") return { userId: "admin-1", isAdmin: true, email: "admin@example.test" };
      return null;
    }),
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    connectors: {
      listConnectors: mocks.listConnectors,
      getConnector: mocks.getConnector,
      getResolvedConnector: mocks.getResolvedConnector,
      createConnector: mocks.createConnector,
      updateConnector: mocks.updateConnector,
      deleteConnector: mocks.deleteConnector,
      getResolvedOAuthApp: mocks.getResolvedOAuthApp,
      upsertOAuthApp: mocks.upsertOAuthApp,
    },
    store: {},
  },
}));

vi.mock("../connectors/syncExecutor.js", () => ({
  runConnectorSync: mocks.runConnectorSync,
}));

vi.mock("../memory/scheduler/jobs.js", () => ({
  enqueueAgentJob: mocks.enqueueAgentJob,
}));

vi.mock("../connectors/resources.js", () => ({
  CONNECTOR_RESOURCE_FIELDS: { slack: "channelIds" },
  discoverConnectorAccount: vi.fn(async () => "workspace"),
  discoverConnectorResources: vi.fn(async () => []),
}));

vi.mock("../connectors/oauthBroker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connectors/oauthBroker.js")>();
  return { ...actual, exchangeCode: mocks.exchangeCode };
});

import { signState } from "../connectors/oauthBroker.js";
import { connectorManageRouter } from "../api/routes/connectors/manage.js";
import { connectorOauthRouter } from "../api/routes/connectors/oauth.js";

const createdAt = "2026-07-13T00:00:00.000Z";
function connector(
  id: string,
  orgId: string | null,
  source = "slack",
  userId = "user-1",
): ConnectorConfigRecord {
  return {
    id,
    userId,
    orgId,
    source,
    name: id,
    status: "connected",
    enabled: true,
    visibility: "private",
    config: {},
    hasCredential: true,
    checkpoint: {},
    lastRunAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("connector route organization isolation", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      ["user-1", "admin-1"].includes(userId) && ["org-a", "org-b"].includes(orgId)
        ? "admin"
        : null);
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });
    mocks.listConnectors.mockResolvedValue([]);
    mocks.getResolvedOAuthApp.mockResolvedValue({
      orgId: "org-a",
      source: "slack",
      clientId: "client-a",
      clientSecret: "secret-a",
      scopes: "channels:read",
    });
    mocks.createConnector.mockImplementation(async (userId: string, input: Record<string, unknown>) =>
      connector("conn-created", String(input.orgId ?? ""), String(input.source ?? "slack"), userId));
    mocks.updateConnector.mockImplementation(async (id: string) => connector(id, "org-a"));
    mocks.runConnectorSync.mockResolvedValue({ ok: true, documents: 1, imported: 1 });
    mocks.exchangeCode.mockResolvedValue({ accessToken: "provider-token" });

    const app = express();
    app.use(express.json());
    app.use("/api/connectors", connectorOauthRouter);
    app.use("/api/connectors", connectorManageRouter);
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

  const headers = (orgId = "org-a", token = "br_user") => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-BrainRouter-Org": orgId,
  });

  it("lists only connectors owned by the caller in the active organization", async () => {
    mocks.listConnectors.mockResolvedValue([
      connector("conn-a", "org-a"),
      connector("conn-b", "org-b"),
      connector("conn-legacy", null),
    ]);

    const response = await fetch(`${baseUrl}/api/connectors`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connectors: [{ id: "conn-a", orgId: "org-a" }] });
  });

  it("never falls back to another organization or a legacy unscoped source connector", async () => {
    mocks.listConnectors.mockResolvedValue([
      connector("conn-b", "org-b"),
      connector("conn-legacy", null),
    ]);

    const response = await fetch(`${baseUrl}/api/connectors/slack/status`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "slack", connected: false, connector: null });
    expect(mocks.getResolvedConnector).not.toHaveBeenCalled();
  });

  it("creates private connectors inside the active organization", async () => {
    const response = await fetch(`${baseUrl}/api/connectors`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ source: "slack", name: "Support Slack", visibility: "private" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.createConnector).toHaveBeenCalledWith("user-1", expect.objectContaining({
      source: "slack",
      orgId: "org-a",
      visibility: "private",
    }));
  });

  it.each([
    ["PATCH", "/api/connectors/conn-b"],
    ["DELETE", "/api/connectors/conn-b"],
    ["POST", "/api/connectors/conn-b/run"],
  ])("blocks %s id operations outside the active organization", async (method, path) => {
    mocks.getConnector.mockResolvedValue(connector("conn-b", "org-b"));

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers("org-a", "br_admin"),
      body: method === "PATCH" ? JSON.stringify({ enabled: false }) : undefined,
    });

    expect(response.status).toBe(404);
    expect(mocks.updateConnector).not.toHaveBeenCalled();
    expect(mocks.deleteConnector).not.toHaveBeenCalled();
    expect(mocks.runConnectorSync).not.toHaveBeenCalled();
  });

  it("binds OAuth reconnect state to the active organization and route source", async () => {
    mocks.getConnector.mockResolvedValue(connector("conn-b", "org-b", "gitlab"));

    const response = await fetch(
      `${baseUrl}/api/connectors/slack/oauth/start?connectorId=conn-b`,
      { method: "POST", headers: headers() },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/access denied/i) });
  });

  it("revalidates signed callback connector organization and source before exchanging a code", async () => {
    mocks.getConnector.mockResolvedValue(connector("conn-b", "org-b", "gitlab"));
    const state = signState({
      userId: "user-1",
      orgId: "org-a",
      source: "slack",
      connectorId: "conn-b",
      iat: Math.floor(Date.now() / 1000),
    }, "brainrouter-dev-oauth-state");

    const response = await fetch(
      `${baseUrl}/api/connectors/slack/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(403);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.updateConnector).not.toHaveBeenCalled();
  });
});
