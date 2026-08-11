import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedConnector: vi.fn(),
  updateDbConnector: vi.fn(),
  importMemories: vi.fn(),
  listFileConnectors: vi.fn(),
  createFileConnector: vi.fn(),
  updateFileConnector: vi.fn(),
  runConnectorCheckpointCore: vi.fn(),
  exportConnectorDocumentsForMemory: vi.fn(),
  githubTokenClient: vi.fn(),
  ingestConnectorSources: vi.fn(),
  connectorRecordIdsByDocument: vi.fn(),
  refreshConnectedIssueDocuments: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    connectors: {
      getResolvedConnector: mocks.getResolvedConnector,
      updateConnector: mocks.updateDbConnector,
    },
    importMemories: mocks.importMemories,
    store: { storeKind: "test" },
  },
}));

vi.mock("@kinqs/brainrouter-core/connectors", () => ({
  listConnectors: mocks.listFileConnectors,
  createConnector: mocks.createFileConnector,
  updateConnector: mocks.updateFileConnector,
  runConnectorCheckpointCore: mocks.runConnectorCheckpointCore,
  exportConnectorDocumentsForMemory: mocks.exportConnectorDocumentsForMemory,
  githubTokenClient: mocks.githubTokenClient,
}));

vi.mock("./knowledgeImport.js", () => ({
  ingestConnectorSources: mocks.ingestConnectorSources,
  connectorRecordIdsByDocument: mocks.connectorRecordIdsByDocument,
}));

vi.mock("../memory/planner/backend.js", () => ({
  refreshConnectedIssueDocuments: mocks.refreshConnectedIssueDocuments,
}));

import { runConnectorSync } from "./syncExecutor.js";

const syncedDocument = {
  id: "github:org/repo:issue:7",
  connectorId: "runtime-connector-1",
  source: "github",
  kind: "issue",
  repository: "org/repo",
  title: "Scoped issue",
  url: "https://github.example/org/repo/issues/7",
  text: "Scoped connector knowledge",
  metadata: {},
  firstSeenAt: "2026-07-13T00:00:00.000Z",
  lastSeenAt: "2026-07-13T00:00:00.000Z",
};

describe("server connector sync knowledge scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getResolvedConnector.mockResolvedValue({
      id: "db-connector-1",
      userId: "user-1",
      orgId: "org-1",
      source: "github",
      name: "GitHub",
      status: "connected",
      enabled: true,
      visibility: "org",
      config: {},
      checkpoint: {},
      lastRunAt: null,
      lastError: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      credential: { accessToken: "sealed-token" },
    });
    mocks.listFileConnectors
      .mockReturnValueOnce([])
      .mockReturnValue([{ id: "runtime-connector-1", checkpoint: { cursor: "next" } }]);
    mocks.createFileConnector.mockReturnValue({ id: "runtime-connector-1" });
    mocks.runConnectorCheckpointCore.mockImplementation(async (_workspace, _connectorId, options) => {
      const plannerItemsProjected = await options.projectPlannerIssues({
        connector: { id: "runtime-connector-1", source: "github", name: "GitHub runtime" },
        documents: [syncedDocument],
      });
      return {
        ok: true,
        documents: [syncedDocument],
        failures: [],
        plannerItemsProjected,
        run: { id: "run-1" },
      };
    });
    mocks.exportConnectorDocumentsForMemory.mockReturnValue({
      data: { version: 1, memories: [] },
      recordCount: 1,
      evidenceCount: 0,
      operationCount: 0,
    });
    mocks.importMemories.mockResolvedValue({ importedMemories: 1 });
    mocks.ingestConnectorSources.mockResolvedValue({ documents: 1, chunks: 1, links: 1 });
    mocks.connectorRecordIdsByDocument.mockReturnValue(new Map([[syncedDocument.id, ["connector-memory-1"]]]));
    mocks.updateDbConnector.mockResolvedValue({});
    mocks.refreshConnectedIssueDocuments.mockResolvedValue({
      created: 1, updated: 0, unchanged: 0, skipped: 0,
    });
  });

  it("imports cognitive and source knowledge with the connector's org visibility and no temp-workspace tag", async () => {
    const result = await runConnectorSync("db-connector-1");

    expect(result).toEqual({ ok: true, documents: 1, imported: 1 });
    expect(mocks.exportConnectorDocumentsForMemory).toHaveBeenCalledWith(
      expect.stringContaining("server-connectors/db-connector-1"),
      {
        connectorId: "runtime-connector-1",
        userId: "user-1",
        orgId: "org-1",
        visibility: "org",
        workspaceTag: null,
        projectTag: null,
      },
    );
    expect(mocks.importMemories).toHaveBeenCalledWith("user-1", { version: 1, memories: [] });
    expect(mocks.ingestConnectorSources).toHaveBeenCalledWith(
      expect.objectContaining({ storeKind: "test" }),
      [syncedDocument],
      {
        connectorId: "db-connector-1",
        userId: "user-1",
        orgId: "org-1",
        visibility: "org",
        projectId: null,
        workspaceTag: null,
      },
      new Map([[syncedDocument.id, ["connector-memory-1"]]]),
    );
    expect(mocks.refreshConnectedIssueDocuments).toHaveBeenCalledWith("org-1", "user-1", {
      connectorId: "db-connector-1",
      source: "github",
      sourceLabel: "GitHub",
      documents: [syncedDocument],
    });
  });
});

describe("github device-flow token refresh (multi-account)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listFileConnectors.mockReturnValueOnce([]).mockReturnValue([{ id: "runtime-connector-1", checkpoint: {} }]);
    mocks.createFileConnector.mockReturnValue({ id: "runtime-connector-1" });
    mocks.runConnectorCheckpointCore.mockResolvedValue({ ok: true, documents: [], failures: [], run: { id: "run-1" } });
    mocks.updateDbConnector.mockResolvedValue({});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rotates an expired device token via the GitHub App client id with NO client secret, and seals it back on THIS connector", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    mocks.getResolvedConnector.mockResolvedValue({
      id: "db-connector-work", userId: "user-1", orgId: "org-1", source: "github", name: "GitHub work",
      status: "connected", enabled: true, visibility: "private", config: {}, checkpoint: {},
      lastRunAt: null, lastError: null, createdAt: past, updatedAt: past,
      // A GitHub App device token: expired, refreshable, authMode "device".
      credential: { accessToken: "old-token", refreshToken: "refresh-abc", expiresAt: past, authMode: "device" },
    });
    const fetchMock = vi.fn(async (url: unknown, init: { body?: unknown } = {}) => {
      expect(String(url)).toContain("github.com/login/oauth/access_token");
      const body = String(init.body ?? "");
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=refresh-abc");
      // Device refresh must NOT send a client secret (public client).
      expect(body).not.toContain("client_secret");
      return { ok: true, json: async () => ({ access_token: "new-token", refresh_token: "refresh-def", expires_in: 28800, scope: "repo" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConnectorSync("db-connector-work");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The rotated credential is sealed back onto THIS connector (not the shared key).
    expect(mocks.updateDbConnector).toHaveBeenCalledWith("db-connector-work", expect.objectContaining({
      credential: expect.objectContaining({ accessToken: "new-token", refreshToken: "refresh-def", authMode: "device" }),
      status: "connected",
    }));
  });
});
