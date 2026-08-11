/**
 * ADR-038 D4 — planner HTTP contract through authentication, tenant scoping,
 * typed item/block push, pull and targeted retry.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const records = {
  items: new Map<string, Record<string, unknown>>(),
  blocks: new Map<string, Record<string, unknown>>(),
  applied: new Map<string, {
    itemId: string; entity: "item" | "block"; operationKind: string; fingerprint: string;
  }>(),
  revision: 0,
};
const key = (orgId: string, userId: string, id: string) => `${orgId}/${userId}/${id}`;

const store = {
  async withPlannerMutation<T>(
    _orgId: string,
    _userId: string,
    fn: (locked: any) => Promise<T>,
  ) { return fn(this); },
  async listPlannerItemsSince(orgId: string, userId: string, since = "0") {
    return [...records.items.entries()]
      .filter(([k, row]) => k.startsWith(`${orgId}/${userId}/`) && Number(row.revision) > Number(since))
      .map(([, row]) => row);
  },
  async getPlannerItem(orgId: string, userId: string, id: string) {
    return records.items.get(key(orgId, userId, id)) ?? null;
  },
  async upsertPlannerItem(orgId: string, userId: string, row: Record<string, unknown>) {
    const stored = {
      ...row, revision: String(++records.revision), updatedAt: "2026-08-11T00:00:00.000Z",
    };
    records.items.set(key(orgId, userId, String(row.id)), stored);
    return stored;
  },
  async latestPlannerRevision() { return String(records.revision); },
  async listPlannerBlocks(orgId: string, userId: string) {
    return [...records.blocks.entries()]
      .filter(([k, row]) => k.startsWith(`${orgId}/${userId}/`) && row.deletedAt == null)
      .map(([, row]) => row);
  },
  async listPlannerBlocksSince(orgId: string, userId: string, since = "0") {
    return [...records.blocks.entries()]
      .filter(([k]) => k.startsWith(`${orgId}/${userId}/`))
      .map(([, row]) => row)
      .filter((row) => Number(row.revision) > Number(since))
      .sort((a, b) => Number(a.revision) - Number(b.revision))
      .slice(0, 1000);
  },
  async getPlannerBlock(orgId: string, userId: string, id: string) {
    return records.blocks.get(key(orgId, userId, id)) ?? null;
  },
  async upsertPlannerBlock(orgId: string, userId: string, row: Record<string, unknown>) {
    const stored = { ...row, revision: String(++records.revision) };
    records.blocks.set(key(orgId, userId, String(row.id)), stored);
    return stored;
  },
  async tombstonePlannerBlocksForItem(
    orgId: string,
    userId: string,
    itemId: string,
    deletedAt: Record<string, unknown>,
  ) {
    let changed = 0;
    for (const [recordKey, row] of records.blocks) {
      if (!recordKey.startsWith(`${orgId}/${userId}/`) || row.itemId !== itemId) continue;
      records.blocks.set(recordKey, {
        ...row, deletedAt, updatedAt: deletedAt, revision: String(++records.revision),
      });
      changed += 1;
    }
    return changed;
  },
  async getOperationReceipt(orgId: string, userId: string, idempotencyKey: string) {
    return records.applied.get(key(orgId, userId, idempotencyKey)) ?? null;
  },
  async recordOperationApplied(
    orgId: string, userId: string, idempotencyKey: string, itemId: string,
    entity: "item" | "block", operationKind: string, fingerprint: string,
  ) {
    records.applied.set(key(orgId, userId, idempotencyKey), {
      itemId, entity, operationKind, fingerprint,
    });
  },
};

const tenancy = vi.hoisted(() => ({
  getMemberRole: vi.fn(), getDefaultOrgId: vi.fn(), ensurePersonalOrg: vi.fn(), getUserById: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((apiKey: string) =>
      apiKey === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" } : null),
    getUserById: tenancy.getUserById,
    tenancy: {
      getMemberRole: tenancy.getMemberRole,
      getDefaultOrgId: tenancy.getDefaultOrgId,
      ensurePersonalOrg: tenancy.ensurePersonalOrg,
    },
    get store() { return store; },
  },
}));

const { plannerRouter } = await import("../api/routes/planner.js");

describe("planner routes", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";
  const headers = {
    Authorization: "Bearer br_user",
    "Content-Type": "application/json",
    "X-BrainRouter-Org": "org-a",
  };

  beforeEach(async () => {
    records.items.clear(); records.blocks.clear(); records.applied.clear(); records.revision = 0;
    vi.clearAllMocks();
    tenancy.getDefaultOrgId.mockResolvedValue("org-a");
    tenancy.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    tenancy.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      orgId === "org-a" && userId === "user-1" ? "admin" : null);
    tenancy.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });

    const app = express();
    app.use(express.json());
    app.use("/api/planner", plannerRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("refuses an unauthenticated push before touching the store", async () => {
    const response = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operations: [] }),
    });
    expect(response.status).toBe(401);
    expect(records.items.size).toBe(0);
  });

  it("pushes a time block and returns it to a second device through pull", async () => {
    const itemResponse = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        idempotencyKey: "item:create", itemId: "item-1", kind: "create",
        at: { physical: 900, logical: 0, deviceId: "device-a" }, payload: { title: "Parent" },
      }] }),
    });
    expect((await itemResponse.json()).accepted).toEqual(["item:create"]);
    const response = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        entity: "block", idempotencyKey: "block:create", itemId: "block-1", kind: "create",
        at: { physical: 1_000, logical: 0, deviceId: "device-a" },
        payload: { itemId: "item-1", estimateMinutes: 30, scheduledFor: "2026-08-11T09:00:00.000Z" },
      }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).accepted).toEqual(["block:create"]);

    const pull = await fetch(`${baseUrl}/api/planner/pull`, { headers });
    const body = await pull.json();
    expect(body.blocks).toEqual([expect.objectContaining({ id: "block-1", itemId: "item-1" })]);
    expect(body.items).toEqual([expect.objectContaining({ id: "item-1" })]);
  });

  it("returns actionable rejections for orphan and mismatched block parents", async () => {
    const orphan = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        entity: "block", idempotencyKey: "block:orphan", itemId: "block-1", kind: "create",
        at: { physical: 1_000, logical: 0, deviceId: "device-a" },
        payload: { itemId: "missing", estimateMinutes: 30 },
      }] }),
    });
    expect((await orphan.json()).rejected[0].reason).toBe("The parent planner item missing does not exist.");

    for (const [id, physical] of [["item-1", 1_100], ["item-2", 1_200]] as const) {
      await fetch(`${baseUrl}/api/planner/push`, {
        method: "POST", headers,
        body: JSON.stringify({ operations: [{
          idempotencyKey: `${id}:create`, itemId: id, kind: "create",
          at: { physical, logical: 0, deviceId: "device-a" }, payload: { title: id },
        }] }),
      });
    }
    await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        entity: "block", idempotencyKey: "block:create", itemId: "block-1", kind: "create",
        at: { physical: 1_300, logical: 0, deviceId: "device-a" },
        payload: { itemId: "item-1", estimateMinutes: 30 },
      }] }),
    });
    const mismatch = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        entity: "block", idempotencyKey: "block:reparent", itemId: "block-1", kind: "update",
        at: { physical: 1_400, logical: 0, deviceId: "device-a" }, payload: { itemId: "item-2" },
      }] }),
    });
    expect((await mismatch.json()).rejected[0].reason).toMatch(/cannot move from parent item item-1 to item-2/);
  });

  it("propagates item deletion to block tombstones and accepts synced conflict resolution", async () => {
    for (const operation of [
      {
        idempotencyKey: "item:create", itemId: "item-1", kind: "create",
        at: { physical: 900, logical: 0, deviceId: "device-a" }, payload: { title: "Parent" },
      },
      {
        entity: "block", idempotencyKey: "block:create", itemId: "block-1", kind: "create",
        at: { physical: 1_000, logical: 0, deviceId: "device-a" },
        payload: { itemId: "item-1", estimateMinutes: 30 },
      },
    ]) {
      await fetch(`${baseUrl}/api/planner/push`, {
        method: "POST", headers, body: JSON.stringify({ operations: [operation] }),
      });
    }
    const cursor = (await (await fetch(`${baseUrl}/api/planner/pull`, { headers })).json()).cursor;
    const deleted = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        idempotencyKey: "item:delete", itemId: "item-1", kind: "delete",
        at: { physical: 2_000, logical: 0, deviceId: "device-a" }, payload: {},
      }] }),
    });
    expect((await deleted.json()).accepted).toEqual(["item:delete"]);
    const delta = await (await fetch(`${baseUrl}/api/planner/pull?since=${cursor}`, { headers })).json();
    expect(delta.blocks[0].deletedAt).toEqual({ physical: 2_000, logical: 0, deviceId: "device-a" });
    expect((await (await fetch(`${baseUrl}/api/planner/blocks`, { headers })).json()).blocks).toEqual([]);

    // A separate owned item demonstrates that resolution crosses the same API
    // contract and survives a fresh pull.
    await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        idempotencyKey: "conflict:create", itemId: "conflict-1", kind: "create",
        at: { physical: 2_100, logical: 0, deviceId: "device-a" }, payload: { title: "Base" },
      }] }),
    });
    for (const [deviceId, title] of [["device-a", "A"], ["device-b", "B"]]) {
      await fetch(`${baseUrl}/api/planner/push`, {
        method: "POST", headers,
        body: JSON.stringify({ operations: [{
          idempotencyKey: `conflict:${deviceId}`, itemId: "conflict-1", kind: "update",
          at: { physical: 2_200, logical: 0, deviceId }, payload: { title },
        }] }),
      });
    }
    const resolved = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{
        idempotencyKey: "conflict:resolve", itemId: "conflict-1", kind: "resolve_conflict",
        at: { physical: 2_300, logical: 0, deviceId: "device-a" },
        payload: { field: "title", value: "Chosen" },
      }] }),
    });
    expect((await resolved.json()).accepted).toEqual(["conflict:resolve"]);
    const fresh = await (await fetch(`${baseUrl}/api/planner/pull`, { headers })).json();
    const item = fresh.items.find((candidate: { id: string }) => candidate.id === "conflict-1");
    expect(item.title.value).toBe("Chosen");
    expect(item.conflicts?.title).toBeUndefined();
    expect(item.conflictResolutions.title).toEqual({ physical: 2_300, logical: 0, deviceId: "device-a" });
  });

  it("rejects one malformed operation without stranding its valid sibling", async () => {
    const response = await fetch(`${baseUrl}/api/planner/push`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [
        { entity: "block", idempotencyKey: "bad", itemId: "block-1", kind: "delete", at: {}, payload: {} },
        {
          idempotencyKey: "item:create", itemId: "item-1", kind: "create",
          at: { physical: 1_000, logical: 0, deviceId: "device-a" }, payload: { title: "Plan the day" },
        },
      ] }),
    });
    const body = await response.json();
    expect(body.accepted).toEqual(["item:create"]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].idempotencyKey).toBe("bad");
  });

  it("retries exactly the inspected operation", async () => {
    const operation = {
      idempotencyKey: "item:retry", itemId: "item-1", kind: "create",
      at: { physical: 1_000, logical: 0, deviceId: "device-a" }, payload: { title: "Retry me" },
    };
    const response = await fetch(`${baseUrl}/api/planner/retry`, {
      method: "POST", headers, body: JSON.stringify({ operation }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).accepted).toEqual(["item:retry"]);
    expect(records.items.size).toBe(1);
  });

  it("blocks access to another organization", async () => {
    const response = await fetch(`${baseUrl}/api/planner/pull`, {
      headers: { ...headers, "X-BrainRouter-Org": "org-b" },
    });
    expect(response.status).toBe(403);
  });
});
