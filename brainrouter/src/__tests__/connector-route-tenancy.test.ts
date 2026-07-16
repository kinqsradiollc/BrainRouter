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
  getUserById: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  runConnectorSync: vi.fn(),
  enqueueAgentJob: vi.fn(),
  exchangeCode: vi.fn(),
  probeGithubConnection: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => {
      if (key === "br_user") return { userId: "user-1", isAdmin: false, email: "user@example.test" };
      if (key === "br_admin") return { userId: "admin-1", isAdmin: true, email: "admin@example.test" };
      return null;
    }),
    getUserById: mocks.getUserById,
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
    emailAuth: {
      getSetting: mocks.getSetting,
      setSetting: mocks.setSetting,
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

vi.mock("../api/routes/connectors/githubConnection.js", () => ({
  probeGithubConnection: mocks.probeGithubConnection,
}));

import { signState } from "../connectors/oauthBroker.js";
import { seal } from "../security/secretBox.js";
import { connectorManageRouter } from "../api/routes/connectors/manage.js";
import { connectorOauthRouter } from "../api/routes/connectors/oauth.js";
import { githubConnectorAdminRouter, githubConnectorRouter } from "../api/routes/connectors/github.js";

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
    mocks.getUserById.mockImplementation(async (userId: string) => ({
      userId,
      isAdmin: userId === "admin-1",
      status: "active",
    }));
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
    mocks.enqueueAgentJob.mockResolvedValue(undefined);
    mocks.exchangeCode.mockResolvedValue({ accessToken: "provider-token" });
    mocks.probeGithubConnection.mockResolvedValue({ connected: false });
    mocks.getSetting.mockResolvedValue(null);
    mocks.setSetting.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use("/api/connectors", githubConnectorRouter);
    app.use("/api/connectors", connectorOauthRouter);
    app.use("/api/connectors", connectorManageRouter);
    app.use("/api/admin/connectors", githubConnectorAdminRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it("lets a normal developer manage their own connectors without trigger-admin access", async () => {
    mocks.getMemberRole.mockResolvedValue("member");

    const response = await fetch(`${baseUrl}/api/connectors/slack/status`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "slack", connected: false });
  });

  it("keeps connector mutation unavailable to read-only viewers", async () => {
    mocks.getMemberRole.mockResolvedValue("viewer");

    const response = await fetch(`${baseUrl}/api/connectors/slack/status`, { headers: headers() });

    expect(response.status).toBe(403);
  });

  it("keeps shared OAuth-app configuration admin-only", async () => {
    mocks.getMemberRole.mockResolvedValue("member");

    const response = await fetch(`${baseUrl}/api/connectors/slack/oauth/app`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ clientId: "client", clientSecret: "secret" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.upsertOAuthApp).not.toHaveBeenCalled();
  });

  it("uses the deployment GitHub OAuth App when the org has no duplicate app row", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "11".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.getResolvedOAuthApp.mockResolvedValue(null);
    mocks.getSetting.mockResolvedValue({
      clientId: "deployment-github-client",
      clientSecretSealed: seal("deployment-github-secret"),
      redirectBase: baseUrl,
    });

    const response = await fetch(`${baseUrl}/api/connectors/github/oauth/start`, {
      method: "POST",
      headers: headers(),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { url: string };
    expect(new URL(body.url).searchParams.get("client_id")).toBe("deployment-github-client");
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(`${baseUrl}/api/connectors/github/oauth/callback`);
    vi.unstubAllEnvs();
  });

  it("does not start GitHub web OAuth from an incomplete deployment app", async () => {
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.getResolvedOAuthApp.mockResolvedValue(null);
    mocks.getSetting.mockResolvedValue({ clientId: "deployment-github-client", clientSecretSealed: "" });

    const response = await fetch(`${baseUrl}/api/connectors/github/oauth/start`, {
      method: "POST",
      headers: headers(),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/isn't configured/) });
  });

  it("does not let an admin save a misleading client-id-only GitHub OAuth App", async () => {
    mocks.getSetting.mockResolvedValue({ clientId: "deployment-github-client", clientSecretSealed: "" });

    const response = await fetch(`${baseUrl}/api/admin/connectors/github/app`, {
      method: "POST",
      headers: headers("org-a", "br_admin"),
      body: JSON.stringify({ clientId: "deployment-github-client" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/clientSecret is required/) });
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("stores generic GitHub OAuth as both the org connector and backend account authorization", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "22".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.getResolvedOAuthApp.mockResolvedValue(null);
    mocks.getSetting.mockResolvedValue({
      clientId: "deployment-github-client",
      clientSecretSealed: seal("deployment-github-secret"),
      redirectBase: baseUrl,
    });
    mocks.exchangeCode.mockResolvedValue({ accessToken: "provider-token", scope: "repo" });
    const state = signState({
      userId: "user-1",
      orgId: "org-a",
      source: "github",
      iat: Math.floor(Date.now() / 1000),
    }, "22".repeat(32));

    const response = await fetch(
      `${baseUrl}/api/connectors/github/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );

    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(mocks.createConnector).toHaveBeenCalledWith("user-1", expect.objectContaining({
      source: "github",
      orgId: "org-a",
      credential: expect.objectContaining({ accessToken: "provider-token", authMode: "web" }),
    }));
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "connectorToken:github:user-1",
      expect.objectContaining({ sealed: expect.any(String) }),
    );
    vi.unstubAllEnvs();
  });

  it("allows a current global admin to finish OAuth for an organization they do not belong to", async () => {
    mocks.getMemberRole.mockResolvedValue(null);
    mocks.getResolvedOAuthApp.mockResolvedValue({
      orgId: "org-b",
      source: "slack",
      clientId: "client-b",
      clientSecret: "secret-b",
      scopes: "channels:read",
    });
    const state = signState({
      userId: "admin-1",
      orgId: "org-b",
      source: "slack",
      iat: Math.floor(Date.now() / 1000),
    }, "brainrouter-dev-oauth-state");

    const response = await fetch(
      `${baseUrl}/api/connectors/slack/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(200);
    expect(mocks.createConnector).toHaveBeenCalledWith("admin-1", expect.objectContaining({ orgId: "org-b", source: "slack" }));
  });

  it("migrates a healthy pre-connector GitHub account once into the active organization", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "33".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.getSetting.mockImplementation(async (key: string) => key === "connectorToken:github:user-1" ? {
      sealed: seal(JSON.stringify({
        accessToken: "legacy-github-token",
        login: "octocat",
        scope: "repo",
        connectedAt: createdAt,
        flow: "web",
      })),
    } : null);
    mocks.probeGithubConnection.mockResolvedValue({ connected: true, login: "octocat" });

    const response = await fetch(`${baseUrl}/api/connectors/github/status`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connected: true, connector: { orgId: "org-a", source: "github" } });
    expect(mocks.createConnector).toHaveBeenCalledWith("user-1", expect.objectContaining({
      orgId: "org-a",
      source: "github",
      credential: expect.objectContaining({ accessToken: "legacy-github-token" }),
    }));
    vi.unstubAllEnvs();
  });

  it("does not copy a user-wide GitHub compatibility token into a second organization", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "44".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.listConnectors.mockResolvedValue([connector("github-b", "org-b", "github")]);
    mocks.getSetting.mockImplementation(async (key: string) => key === "connectorToken:github:user-1" ? {
      sealed: seal(JSON.stringify({
        accessToken: "org-b-github-token",
        login: "octocat",
        scope: "repo",
        connectedAt: createdAt,
        flow: "web",
      })),
    } : null);
    mocks.probeGithubConnection.mockResolvedValue({ connected: true, login: "octocat" });

    const response = await fetch(`${baseUrl}/api/connectors/github/status`, { headers: headers("org-a") });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connected: false, connector: null });
    expect(mocks.createConnector).not.toHaveBeenCalled();
    expect(mocks.probeGithubConnection).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("cancels only a device authorization bound to the active organization", async () => {
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.getSetting.mockImplementation(async (key: string) => key === "connectorDevice:github:user-1"
      ? { deviceCode: "sealed-server-value", orgId: "org-a", exp: Math.floor(Date.now() / 1000) + 600 }
      : null);

    const response = await fetch(`${baseUrl}/api/connectors/github/device/cancel`, {
      method: "POST",
      headers: headers("org-a"),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.setSetting).toHaveBeenCalledWith("connectorDevice:github:user-1", {});

    mocks.setSetting.mockClear();
    mocks.getSetting.mockResolvedValue({ deviceCode: "other-org-value", orgId: "org-b" });
    const crossOrg = await fetch(`${baseUrl}/api/connectors/github/device/cancel`, {
      method: "POST",
      headers: headers("org-a"),
    });
    expect(crossOrg.status).toBe(200);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("uses the active organization's GitHub connector credential", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "55".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    mocks.listConnectors.mockResolvedValue([connector("github-a", "org-a", "github")]);
    mocks.getResolvedConnector.mockResolvedValue({
      ...connector("github-a", "org-a", "github"),
      credential: { accessToken: "org-a-github-token", scope: "repo" },
    });
    mocks.getSetting.mockImplementation(async (key: string) => key === "connectorToken:github:user-1" ? {
      sealed: seal(JSON.stringify({
        accessToken: "different-account-token",
        login: "other",
        scope: "repo",
        connectedAt: createdAt,
        flow: "web",
      })),
    } : null);
    mocks.probeGithubConnection.mockImplementation(async (token: string) => ({ connected: token === "org-a-github-token", login: "octocat" }));

    const response = await fetch(`${baseUrl}/api/connectors/github/status`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connected: true, connector: { id: "github-a", orgId: "org-a" } });
    expect(mocks.probeGithubConnection).toHaveBeenCalledWith("org-a-github-token");
    vi.unstubAllEnvs();
  });

  it("preserves a device connector's installation access mode independently of the compatibility account", async () => {
    vi.stubEnv("BRAINROUTER_SECRET_KEY", "66".repeat(32));
    mocks.getMemberRole.mockResolvedValue("member");
    const deviceConnector = { ...connector("github-a", "org-a", "github"), config: {} };
    mocks.listConnectors.mockResolvedValue([deviceConnector]);
    mocks.getResolvedConnector.mockResolvedValue({
      ...deviceConnector,
      credential: { accessToken: "org-a-device-token", scope: "", authMode: "device" },
    });
    mocks.getSetting.mockImplementation(async (key: string) => key === "connectorToken:github:user-1" ? {
      sealed: seal(JSON.stringify({
        accessToken: "newer-org-web-token",
        login: "other",
        scope: "repo",
        connectedAt: createdAt,
        flow: "web",
      })),
    } : null);
    mocks.probeGithubConnection.mockResolvedValue({ connected: true, login: "octocat" });

    const response = await fetch(`${baseUrl}/api/connectors/github/status`, { headers: headers() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ connected: true, authMode: "device", connector: { id: "github-a" } });
    expect(mocks.getResolvedConnector).toHaveBeenCalledWith("github-a");
    vi.unstubAllEnvs();
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
