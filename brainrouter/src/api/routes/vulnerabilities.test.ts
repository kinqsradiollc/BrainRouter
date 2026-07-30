import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => ({
  enqueueAgentJob: vi.fn(),
  projects: vi.fn(),
  createScan: vi.fn(),
  replaceComponents: vi.fn(),
  getScan: vi.fn(),
  finishScan: vi.fn(),
  sources: vi.fn(),
  activeRuns: vi.fn(),
}));

vi.mock("../../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      listVulnerabilities: vi.fn(async () => ({ items: [], total: 0 })),
      listVulnerabilitySources: mocks.sources,
      listActiveVulnerabilityFeedRuns: mocks.activeRuns,
      createVulnerabilityScan: mocks.createScan,
      replaceAssetComponents: mocks.replaceComponents,
      getVulnerabilityScan: mocks.getScan,
      finishVulnerabilityScan: mocks.finishScan,
    },
    projects: { listAccessibleProjects: mocks.projects },
    emailAuth: { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) },
    integrations: { getResolvedIntegration: vi.fn(async () => null) },
  },
}));
vi.mock("../../memory/scheduler/jobs.js", () => ({ enqueueAgentJob: mocks.enqueueAgentJob }));
vi.mock("../middleware/auth.js", () => ({
  requireAnyAuth: (req: any, _res: any, next: () => void) => { req.userId = "user-a"; req.isAdmin = false; next(); },
}));
vi.mock("../middleware/tenancy.js", () => ({
  requirePermission: (_cap: string) => (req: any, _res: any, next: () => void) => { req.orgId = "org-a"; req.role = "maintainer"; next(); },
}));

import { vulnerabilitiesRouter } from "./vulnerabilities.js";
import { __setCacheForTests, createCache } from "../../infra/cache.js";

let server: Server | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  __setCacheForTests(createCache()); // fresh in-process cache each test — no cross-case bleed
  mocks.projects.mockResolvedValue([{ repoUrl: "https://github.com/acme/app.git" }]);
  mocks.createScan.mockResolvedValue({ id: "scan-1", status: "running" });
  mocks.getScan.mockResolvedValue({ id: "scan-1", status: "running", repo: "acme/app" });
  mocks.enqueueAgentJob.mockResolvedValue({ job: { id: "job-1", status: "pending" }, deduped: false });
  mocks.sources.mockResolvedValue([]);
  mocks.activeRuns.mockResolvedValue([]);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/vulnerability", vulnerabilitiesRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/vulnerability`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
});

describe("vulnerability API background operations", () => {
  it("returns visible per-source ingestion progress", async () => {
    mocks.sources.mockResolvedValue([{ id: "nvd", displayName: "NVD CVE API 2.0" }]);
    mocks.activeRuns.mockResolvedValue([{ id: "run-1", sourceId: "nvd", startedAt: "2026-07-15T00:00:00Z", itemsSeen: 500, itemsUpserted: 42 }]);
    const response = await fetch(`${baseUrl}/sources`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sources: [{
      id: "nvd", displayName: "NVD CVE API 2.0",
      activeRun: { id: "run-1", sourceId: "nvd", startedAt: "2026-07-15T00:00:00Z", itemsSeen: 500, itemsUpserted: 42 },
    }] });
  });

  it("queues a durable source refresh and returns pollable job state", async () => {
    const response = await fetch(`${baseUrl}/sources/nvd/refresh`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ sourceId: "nvd", job: { id: "job-1", status: "pending", deduped: false } });
    expect(mocks.enqueueAgentJob).toHaveBeenCalledWith(expect.anything(), "vulnerability_sync", expect.objectContaining({ mode: "manual", sourceId: "nvd", orgId: "org-a", requestedBy: "user-a" }), { priority: 100 });
  });

  it("authorizes the repository, persists exact inventory, and queues OSV matching", async () => {
    const packageLock = JSON.stringify({ packages: { "": { version: "1.0.0" }, "node_modules/demo": { version: "1.2.3" } } });
    const response = await fetch(`${baseUrl}/scans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "acme/app", files: [{ path: "package-lock.json", content: packageLock }] }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ scan: { id: "scan-1", status: "running" }, job: { id: "job-1", status: "pending" }, componentsSeen: 1 });
    expect(mocks.replaceComponents).toHaveBeenCalledWith("org-a", "acme/app", "scan-1", [expect.objectContaining({ packageName: "demo", version: "1.2.3", purl: "pkg:npm/demo@1.2.3", evidence: "package-lock.json" })]);
    expect(mocks.enqueueAgentJob).toHaveBeenCalledWith(expect.anything(), "vulnerability_scan", { orgId: "org-a", userId: "user-a", repo: "acme/app", scanId: "scan-1" }, { priority: 90 });
  });

  it("fails closed before creating a scan when current repository access is absent", async () => {
    mocks.projects.mockResolvedValue([]);
    const response = await fetch(`${baseUrl}/scans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "other/private", files: [{ path: "requirements.txt", content: "demo==1.0.0" }] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.createScan).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentJob).not.toHaveBeenCalled();
  });

  it("rejects loose manifests that do not prove an installed version", async () => {
    const response = await fetch(`${baseUrl}/scans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "acme/app", files: [{ path: "requirements.txt", content: "demo>=1.0" }] }),
    });
    expect(response.status).toBe(422);
    expect(mocks.createScan).not.toHaveBeenCalled();
  });
});
