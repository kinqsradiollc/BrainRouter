import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTrackItems: vi.fn(),
  createTrackItem: vi.fn(),
  getTrackItem: vi.fn(),
  getTrackItemBySourceRef: vi.fn(),
  transitionTrackItem: vi.fn(),
  updateTrackItem: vi.fn(),
  deleteTrackItem: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" } : null),
    getUserById: mocks.getUserById,
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    store: {
      listTrackItems: mocks.listTrackItems,
      createTrackItem: mocks.createTrackItem,
      getTrackItem: mocks.getTrackItem,
      getTrackItemBySourceRef: mocks.getTrackItemBySourceRef,
      transitionTrackItem: mocks.transitionTrackItem,
      updateTrackItem: mocks.updateTrackItem,
      deleteTrackItem: mocks.deleteTrackItem,
    },
  },
}));

import { trackRouter } from "../api/routes/track.js";

function item(id: string, orgId = "org-a", statusCategory = "todo") {
  return { id, orgId, userId: "user-1", title: "T", description: "", type: "task", status: statusCategory, statusCategory, priority: "medium", assignee: null, labels: [], source: "manual", sourceRef: null, completedAt: null, archivedAt: null, createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" };
}

describe("track route — org isolation + CRUD wiring", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    // user-1 belongs to org-a only.
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      userId === "user-1" && orgId === "org-a" ? "admin" : null);
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });
    mocks.listTrackItems.mockResolvedValue([item("wi_1")]);
    mocks.createTrackItem.mockImplementation(async (input: Record<string, unknown>) => item(String(input.id), String(input.orgId), String(input.statusCategory ?? "todo")));
    mocks.getTrackItemBySourceRef.mockResolvedValue(null);
    mocks.transitionTrackItem.mockImplementation(async (orgId: string, id: string, _s: string, cat: string) => item(id, orgId, cat));
    mocks.deleteTrackItem.mockResolvedValue(true);

    const app = express();
    app.use(express.json());
    app.use("/api/track", trackRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

  const headers = (orgId = "org-a") => ({ Authorization: "Bearer br_user", "Content-Type": "application/json", "X-BrainRouter-Org": orgId });

  it("lists the active org's items", async () => {
    const res = await fetch(`${baseUrl}/api/track`, { headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(mocks.listTrackItems).toHaveBeenCalledWith("org-a", { includeArchived: false });
  });

  it("creates an item scoped to the caller's org", async () => {
    const res = await fetch(`${baseUrl}/api/track`, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Ship it" }) });
    expect(res.status).toBe(201);
    expect(mocks.createTrackItem.mock.calls[0]![0].orgId).toBe("org-a");
    expect(mocks.createTrackItem.mock.calls[0]![0].userId).toBe("user-1");
  });

  it("rejects an empty title with 400", async () => {
    const res = await fetch(`${baseUrl}/api/track`, { method: "POST", headers: headers(), body: JSON.stringify({ title: "   " }) });
    expect(res.status).toBe(400);
    expect(mocks.createTrackItem).not.toHaveBeenCalled();
  });

  it("transitions an item to done (completed bucket)", async () => {
    const res = await fetch(`${baseUrl}/api/track/wi_1/transition`, { method: "POST", headers: headers(), body: JSON.stringify({ status: "done", statusCategory: "completed" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).item.statusCategory).toBe("completed");
    expect(mocks.transitionTrackItem).toHaveBeenCalledWith("org-a", "wi_1", "done", "completed");
  });

  it("rejects a transition with an invalid category", async () => {
    const res = await fetch(`${baseUrl}/api/track/wi_1/transition`, { method: "POST", headers: headers(), body: JSON.stringify({ statusCategory: "bogus" }) });
    expect(res.status).toBe(400);
  });

  it("deletes (untracks) an item", async () => {
    const res = await fetch(`${baseUrl}/api/track/wi_1`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    expect(mocks.deleteTrackItem).toHaveBeenCalledWith("org-a", "wi_1");
  });

  it("blocks access to an org the caller is not a member of (403)", async () => {
    const res = await fetch(`${baseUrl}/api/track`, { headers: headers("org-b") });
    expect(res.status).toBe(403);
    expect(mocks.listTrackItems).not.toHaveBeenCalled();
  });
});
