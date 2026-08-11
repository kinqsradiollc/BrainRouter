/**
 * ADR-038 D3/D4 — the planner server validates entity-specific operations and
 * persists time blocks without routing them through item merge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hlc, PlannerItem } from "@kinqs/brainrouter-core/planner";

interface ItemRow {
  id: string;
  origin: "owned" | "mirrored";
  source: string | null;
  payload: PlannerItem;
  revision: string;
  updatedAt: string;
}

interface BlockRow {
  id: string;
  itemId: string;
  scheduledFor: string | null;
  estimateMinutes: number;
  actualMinutes: number | null;
  carriedOver: number;
  completedAt: string | null;
  revision: string;
  updatedAt: Hlc;
  deletedAt: Hlc | null;
}

class FakePlannerStore {
  items = new Map<string, ItemRow>();
  blocks = new Map<string, BlockRow>();
  applied = new Map<string, {
    itemId: string;
    entity: "item" | "block" | null;
    operationKind: string | null;
    fingerprint: string | null;
  }>();
  revision = 0;
  private lockTails = new Map<string, Promise<void>>();
  itemReadGate?: { id: string; entered: () => void; wait: Promise<void> };
  blockReadGate?: { id: string; entered: () => void; wait: Promise<void> };

  private key(orgId: string, userId: string, id: string): string {
    return `${orgId}/${userId}/${id}`;
  }

  async withPlannerMutation<T>(
    orgId: string,
    userId: string,
    fn: (locked: FakePlannerStore) => Promise<T>,
  ): Promise<T> {
    const key = `${orgId}/${userId}`;
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const ticket = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => ticket);
    this.lockTails.set(key, tail);
    await previous;
    try {
      return await fn(this);
    } finally {
      release();
      if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
    }
  }

  async listPlannerItemsSince(orgId: string, userId: string, since = "0"): Promise<ItemRow[]> {
    return [...this.items.entries()]
      .filter(([key, row]) => key.startsWith(`${orgId}/${userId}/`) && Number(row.revision) > Number(since))
      .map(([, row]) => row)
      .sort((a, b) => Number(a.revision) - Number(b.revision))
      .slice(0, 1000);
  }

  async getPlannerItem(orgId: string, userId: string, id: string): Promise<ItemRow | null> {
    const row = this.items.get(this.key(orgId, userId, id)) ?? null;
    const gate = this.itemReadGate;
    if (gate?.id === id) {
      this.itemReadGate = undefined;
      gate.entered();
      await gate.wait;
    }
    return row;
  }

  async upsertPlannerItem(orgId: string, userId: string, row: Omit<ItemRow, "revision" | "updatedAt">): Promise<ItemRow> {
    const stored: ItemRow = {
      ...row,
      revision: String(++this.revision),
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    this.items.set(this.key(orgId, userId, row.id), stored);
    return stored;
  }

  async latestPlannerRevision(orgId: string, userId: string): Promise<string> {
    const revisions = [...this.items.entries()]
      .filter(([key]) => key.startsWith(`${orgId}/${userId}/`))
      .map(([, row]) => Number(row.revision));
    return String(Math.max(0, ...revisions));
  }

  async listPlannerBlocks(orgId: string, userId: string): Promise<BlockRow[]> {
    return [...this.blocks.entries()]
      .filter(([key, row]) => key.startsWith(`${orgId}/${userId}/`) && row.deletedAt === null)
      .map(([, row]) => row);
  }

  async listPlannerBlocksSince(orgId: string, userId: string, since = "0"): Promise<BlockRow[]> {
    return [...this.blocks.entries()]
      .filter(([key]) => key.startsWith(`${orgId}/${userId}/`))
      .map(([, row]) => row)
      .filter((row) => Number(row.revision) > Number(since))
      .sort((a, b) => Number(a.revision) - Number(b.revision))
      .slice(0, 1000);
  }

  async getPlannerBlock(orgId: string, userId: string, id: string): Promise<BlockRow | null> {
    const row = this.blocks.get(this.key(orgId, userId, id)) ?? null;
    const gate = this.blockReadGate;
    if (gate?.id === id) {
      this.blockReadGate = undefined;
      gate.entered();
      await gate.wait;
    }
    return row;
  }

  async upsertPlannerBlock(orgId: string, userId: string, row: BlockRow): Promise<BlockRow> {
    const stored = { ...row, revision: String(++this.revision) };
    this.blocks.set(this.key(orgId, userId, row.id), stored);
    return stored;
  }

  async tombstonePlannerBlocksForItem(
    orgId: string,
    userId: string,
    itemId: string,
    deletedAt: Hlc,
  ): Promise<number> {
    let changed = 0;
    for (const [key, block] of this.blocks) {
      if (!key.startsWith(`${orgId}/${userId}/`) || block.itemId !== itemId) continue;
      this.blocks.set(key, {
        ...block, deletedAt, updatedAt: deletedAt, revision: String(++this.revision),
      });
      changed += 1;
    }
    return changed;
  }

  async getOperationReceipt(orgId: string, userId: string, key: string) {
    return this.applied.get(this.key(orgId, userId, key)) ?? null;
  }

  async recordOperationApplied(
    orgId: string,
    userId: string,
    key: string,
    itemId: string,
    entity: "item" | "block",
    operationKind: string,
    fingerprint: string,
  ): Promise<void> {
    this.applied.set(this.key(orgId, userId, key), {
      itemId, entity, operationKind, fingerprint,
    });
  }
}

const fake = new FakePlannerStore();
vi.mock("../engine.js", () => ({ memoryEngine: { get store() { return fake; } } }));

const planner = await import("./backend.js");
const ORG = "org-a";
const USER = "user-a";
const at = (physical: number, deviceId = "device-a"): Hlc => ({ physical, logical: 0, deviceId });

function itemOperation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: "item:create",
    itemId: "item-1",
    kind: "create",
    at: at(1_000),
    payload: { title: "Plan the day" },
    ...over,
  };
}

describe("planner push contract", () => {
  beforeEach(() => {
    fake.items.clear();
    fake.blocks.clear();
    fake.applied.clear();
    fake.revision = 0;
    fake.itemReadGate = undefined;
    fake.blockReadGate = undefined;
  });

  it("accepts legacy item patches and does not blank title on a partial update", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    const outcome = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:priority",
      kind: "update",
      at: at(2_000),
      payload: { priority: 1 },
    })], "2026-08-11T00:00:01.000Z");

    expect(outcome.accepted).toEqual(["item:priority"]);
    const stored = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(stored?.payload.title.value).toBe("Plan the day");
    expect(stored?.payload.priority?.value).toBe(1);
  });

  it("accepts an exact retry but rejects idempotency-key reuse with different content", async () => {
    const original = itemOperation({ idempotencyKey: "stable-key" });
    expect((await planner.pushUntrustedOperations(
      ORG, USER, [original], "2026-08-11T00:00:00.000Z",
    )).accepted).toEqual(["stable-key"]);
    expect((await planner.pushUntrustedOperations(
      ORG, USER, [original], "2026-08-11T00:00:01.000Z",
    )).accepted).toEqual(["stable-key"]);

    const reused = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "stable-key",
      itemId: "item-2",
      payload: { title: "Different work" },
    })], "2026-08-11T00:00:02.000Z");
    expect(reused.accepted).toEqual([]);
    expect(reused.rejected[0]?.reason).toMatch(/already used for a different/);
    expect(await fake.getPlannerItem(ORG, USER, "item-2")).toBeNull();
  });

  it("serializes concurrent device merges so different fields cannot be lost", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let releaseRead!: () => void;
    const wait = new Promise<void>((resolve) => { releaseRead = resolve; });
    fake.itemReadGate = { id: "item-1", entered: signalEntered, wait };

    const priority = planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:priority-concurrent", kind: "update", at: at(2_000, "device-a"),
      payload: { priority: 1 },
    })], "2026-08-11T00:00:01.000Z");
    await entered;
    const dueDate = planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:due-concurrent", kind: "update", at: at(2_000, "device-b"),
      payload: { dueDate: "2026-08-20T00:00:00.000Z" },
    })], "2026-08-11T00:00:01.000Z");
    releaseRead();
    const outcomes = await Promise.all([priority, dueDate]);

    expect(outcomes.flatMap((outcome) => outcome.accepted)).toEqual([
      "item:priority-concurrent", "item:due-concurrent",
    ]);
    const stored = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(stored?.payload.priority?.value).toBe(1);
    expect(stored?.payload.dueDate?.value).toBe("2026-08-20T00:00:00.000Z");
  });

  it("accepts a stamped whole item and preserves actionable provenance", async () => {
    const stamp = at(1_000);
    const outcome = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      payload: {
        id: "item-1",
        origin: "mirrored",
        source: "github",
        fetchedAt: "2026-08-11T00:00:00.000Z",
        title: { value: "Connected issue", at: stamp },
        estimateMinutes: { value: 60, at: stamp },
        blockedReason: { value: "Awaiting review", at: stamp },
        provenance: {
          sourceId: "github",
          sourceLabel: "GitHub issue",
          externalId: "42",
          sourceUrl: "https://github.com/example/repo/issues/42",
          fetchedAt: "2026-08-11T00:00:00.000Z",
        },
      },
    })], "2026-08-11T00:00:00.000Z");

    expect(outcome.accepted).toEqual(["item:create"]);
    const stored = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(stored?.payload.origin).toBe("mirrored");
    expect(stored?.payload.provenance?.sourceUrl).toContain("/issues/42");
    expect(stored?.payload.estimateMinutes).toBe(60);
    expect(stored?.payload.blockedReason?.value).toBe("Awaiting review");

    await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:metadata",
      kind: "update",
      at: at(2_000),
      payload: { priority: 1, estimateMinutes: 90 },
    })], "2026-08-11T00:00:01.000Z");
    const updated = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(updated?.payload.title.value).toBe("Connected issue");
    expect(updated?.payload.priority?.value).toBe(1);
    expect(updated?.payload.estimateMinutes).toBe(90);
  });

  it("projects scoped connector issues durably and skips unchanged refresh churn", async () => {
    const document = {
      id: "github:example/repo:issue:42", connectorId: "runtime-connector", source: "github" as const,
      kind: "issue" as const, repository: "example/repo", title: "#42 Connected issue",
      url: "https://github.com/example/repo/issues/42", updatedAt: "2026-08-11T00:00:00.000Z",
      text: "Issue body", metadata: { blockedReason: "Waiting for API", estimateMinutes: 45 },
      firstSeenAt: "2026-08-11T01:00:00.000Z", lastSeenAt: "2026-08-11T01:00:00.000Z",
    };
    const input = {
      connectorId: "db-connector", source: "github" as const,
      sourceLabel: "GitHub work", documents: [document],
    };
    const first = await planner.refreshConnectedIssueDocuments(ORG, USER, input);
    const revisionAfterFirst = fake.revision;
    const second = await planner.refreshConnectedIssueDocuments(ORG, USER, input);
    const stored = [...fake.items.values()][0]?.payload;

    expect(first).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 0 });
    expect(second).toEqual({ created: 0, updated: 0, unchanged: 1, skipped: 0 });
    expect(fake.revision).toBe(revisionAfterFirst);
    expect(stored?.provenance).toEqual(expect.objectContaining({
      sourceId: "connector:db-connector",
      sourceUrl: "https://github.com/example/repo/issues/42",
      fetchedAt: "2026-08-11T01:00:00.000Z",
    }));
    expect(stored?.estimateMinutes).toBe(45);
    expect(stored?.blockedReason?.value).toBe("Waiting for API");
    expect(Object.hasOwn(stored ?? {}, "completed")).toBe(false);
  });

  it("rejects source-owned mirrored writes without changing the cached source record", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      payload: { origin: "mirrored", source: "github", title: "Connected issue" },
    })], "2026-08-11T00:00:00.000Z");

    const rename = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:rename", kind: "update", at: at(2_000),
      payload: { title: "Local-only rename" },
    })], "2026-08-11T00:00:01.000Z");
    const deletion = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:delete", kind: "delete", at: at(3_000), payload: {},
    })], "2026-08-11T00:00:02.000Z");
    const recreate = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:recreate", kind: "create", at: at(4_000),
      payload: { origin: "mirrored", source: "github", title: "Recreated locally" },
    })], "2026-08-11T00:00:03.000Z");

    expect(rename.rejected[0]?.reason).toMatch(/connected source owns title/i);
    expect(deletion.rejected[0]?.reason).toMatch(/belongs to github/i);
    expect(recreate.rejected[0]?.reason).toMatch(/refresh it from its source/i);
    expect((await fake.getPlannerItem(ORG, USER, "item-1"))?.payload.title.value)
      .toBe("Connected issue");
    expect(fake.applied.has(`${ORG}/${USER}/item:rename`)).toBe(false);
    expect(fake.applied.has(`${ORG}/${USER}/item:delete`)).toBe(false);
  });

  it("persists a scheduled block as a block and pulls it on another device", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    const outcome = await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block",
      idempotencyKey: "block:create",
      itemId: "block-1",
      kind: "create",
      at: at(2_000),
      payload: {
        itemId: "item-1",
        scheduledFor: "2026-08-11T09:00:00.000Z",
        estimateMinutes: 45,
      },
    }], "2026-08-11T00:00:01.000Z");

    expect(outcome.accepted).toEqual(["block:create"]);
    expect(fake.items.size).toBe(1);
    expect(fake.blocks.size).toBe(1);
    const pull = await planner.pullChanges(ORG, USER);
    expect(pull.blocks).toEqual([expect.objectContaining({
      id: "block-1", itemId: "item-1", estimateMinutes: 45,
    })]);
  });

  it("deleting an item durably tombstones its blocks for existing and fresh devices", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block", idempotencyKey: "block:create", itemId: "block-1", kind: "create",
      at: at(2_000), payload: { itemId: "item-1", estimateMinutes: 30 },
    }], "2026-08-11T00:00:01.000Z");
    const beforeDelete = await planner.pullChanges(ORG, USER);
    const deletion = await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
      idempotencyKey: "item:delete", kind: "delete", at: at(3_000), payload: {},
    })], "2026-08-11T00:00:02.000Z");

    expect(deletion.accepted).toEqual(["item:delete"]);
    expect((await fake.getPlannerBlock(ORG, USER, "block-1"))?.deletedAt).toEqual(at(3_000));
    expect(await planner.listBlocks(ORG, USER)).toEqual([]);
    const delta = await planner.pullChanges(ORG, USER, beforeDelete.cursor);
    expect(delta.items[0]?.deletedAt).toEqual(at(3_000));
    expect(delta.blocks[0]?.deletedAt).toEqual(at(3_000));
    const fresh = await planner.pullChanges(ORG, USER);
    expect(fresh.blocks[0]?.deletedAt).toEqual(at(3_000));
  });

  it("syncs conflict resolutions and converges concurrent device choices", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    for (const [deviceId, title] of [["device-a", "Device A"], ["device-b", "Device B"]] as const) {
      await planner.pushUntrustedOperations(ORG, USER, [itemOperation({
        idempotencyKey: `item:title:${deviceId}`, kind: "update", at: at(2_000, deviceId),
        payload: { title },
      })], "2026-08-11T00:00:01.000Z");
    }
    expect((await fake.getPlannerItem(ORG, USER, "item-1"))?.payload.conflicts?.title).toBeDefined();

    const resolutions = await Promise.all([
      planner.pushUntrustedOperations(ORG, USER, [{
        idempotencyKey: "item:resolve:a", itemId: "item-1", kind: "resolve_conflict",
        at: at(3_000, "device-a"), payload: { field: "title", value: "Keep A" },
      }], "2026-08-11T00:00:02.000Z"),
      planner.pushUntrustedOperations(ORG, USER, [{
        idempotencyKey: "item:resolve:b", itemId: "item-1", kind: "resolve_conflict",
        at: at(3_000, "device-b"), payload: { field: "title", value: "Keep B" },
      }], "2026-08-11T00:00:02.000Z"),
    ]);
    expect(resolutions.flatMap((outcome) => outcome.accepted)).toEqual([
      "item:resolve:a", "item:resolve:b",
    ]);
    const stored = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(stored?.payload.title.value).toBe("Keep B");
    expect(stored?.payload.conflicts?.title).toBeUndefined();
    expect(stored?.payload.conflictResolutions?.title).toEqual(at(3_000, "device-b"));
    expect((await planner.pullChanges(ORG, USER)).items[0]?.title.value).toBe("Keep B");
  });

  it("durably resolves delete-versus-edit and tombstones child blocks", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block", itemId: "block-1", kind: "create", idempotencyKey: "block:create",
      at: at(1_500), payload: { itemId: "item-1", estimateMinutes: 30 },
    }], "2026-08-11T00:00:00.500Z");
    const row = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(row).not.toBeNull();
    await fake.upsertPlannerItem(ORG, USER, {
      id: row!.id,
      origin: row!.origin,
      source: row!.source,
      payload: {
        ...row!.payload,
        conflicts: {
          deleted: {
            ours: "deleted", theirs: "edited", oursAt: at(2_000),
            theirsAt: at(2_500, "device-b"), reason: "delete_vs_edit",
          },
        },
      },
    });

    const outcome = await planner.pushUntrustedOperations(ORG, USER, [{
      idempotencyKey: "item:resolve:deleted", itemId: "item-1", kind: "resolve_conflict",
      at: at(3_000), payload: { field: "deleted", keep: "ours" },
    }], "2026-08-11T00:00:03.000Z");

    expect(outcome.accepted).toEqual(["item:resolve:deleted"]);
    const stored = await fake.getPlannerItem(ORG, USER, "item-1");
    expect(stored?.payload.deletedAt).toEqual(at(3_000));
    expect(stored?.payload.deletionResolution).toEqual({ deleted: true, at: at(3_000) });
    expect(stored?.payload.conflicts?.deleted).toBeUndefined();
    expect((await fake.getPlannerBlock(ORG, USER, "block-1"))?.deletedAt).toEqual(at(3_000));
  });

  it("a newer block move wins and a stale device cannot move it backwards", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    const create = {
      entity: "block", itemId: "block-1", kind: "create",
      idempotencyKey: "block:create", at: at(1_000),
      payload: { itemId: "item-1", scheduledFor: "2026-08-11T09:00:00.000Z", estimateMinutes: 30 },
    };
    await planner.pushUntrustedOperations(ORG, USER, [create], "2026-08-11T00:00:00.000Z");
    await planner.pushUntrustedOperations(ORG, USER, [{
      ...create, kind: "update", idempotencyKey: "block:new", at: at(3_000, "device-b"),
      payload: { scheduledFor: "2026-08-12T10:00:00.000Z" },
    }], "2026-08-11T00:00:01.000Z");
    const stale = await planner.pushUntrustedOperations(ORG, USER, [{
      ...create, kind: "update", idempotencyKey: "block:stale", at: at(2_000, "device-a"),
      payload: { scheduledFor: "2026-08-11T11:00:00.000Z" },
    }], "2026-08-11T00:00:02.000Z");

    expect(stale.accepted).toEqual(["block:stale"]);
    expect((await fake.getPlannerBlock(ORG, USER, "block-1"))?.scheduledFor)
      .toBe("2026-08-12T10:00:00.000Z");
  });

  it("serializes concurrent block moves so a stale read cannot overwrite a newer move", async () => {
    await planner.pushUntrustedOperations(ORG, USER, [itemOperation()], "2026-08-11T00:00:00.000Z");
    const create = {
      entity: "block", itemId: "block-1", kind: "create",
      idempotencyKey: "block:create", at: at(1_000),
      payload: { itemId: "item-1", scheduledFor: "2026-08-11T09:00:00.000Z", estimateMinutes: 30 },
    };
    await planner.pushUntrustedOperations(ORG, USER, [create], "2026-08-11T00:00:00.000Z");
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let releaseRead!: () => void;
    const wait = new Promise<void>((resolve) => { releaseRead = resolve; });
    fake.blockReadGate = { id: "block-1", entered: signalEntered, wait };

    const stale = planner.pushUntrustedOperations(ORG, USER, [{
      ...create, kind: "update", idempotencyKey: "block:stale-concurrent", at: at(2_000, "device-a"),
      payload: { scheduledFor: "2026-08-11T11:00:00.000Z" },
    }], "2026-08-11T00:00:01.000Z");
    await entered;
    const newer = planner.pushUntrustedOperations(ORG, USER, [{
      ...create, kind: "update", idempotencyKey: "block:new-concurrent", at: at(3_000, "device-b"),
      payload: { scheduledFor: "2026-08-12T10:00:00.000Z" },
    }], "2026-08-11T00:00:01.000Z");
    releaseRead();
    await Promise.all([stale, newer]);

    expect((await fake.getPlannerBlock(ORG, USER, "block-1"))?.scheduledFor)
      .toBe("2026-08-12T10:00:00.000Z");
  });

  it("rejects orphan blocks and refuses to change an existing block's parent", async () => {
    const orphan = await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block", idempotencyKey: "block:orphan", itemId: "block-1", kind: "create",
      at: at(1_000), payload: { itemId: "missing-item", estimateMinutes: 30 },
    }], "2026-08-11T00:00:00.000Z");
    expect(orphan.rejected[0]?.reason).toBe("The parent planner item missing-item does not exist.");
    expect(fake.blocks.size).toBe(0);

    await planner.pushUntrustedOperations(ORG, USER, [
      itemOperation(),
      itemOperation({ idempotencyKey: "item-2:create", itemId: "item-2", payload: { title: "Other" } }),
    ], "2026-08-11T00:00:01.000Z");
    await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block", idempotencyKey: "block:create", itemId: "block-1", kind: "create",
      at: at(2_000), payload: { itemId: "item-1", estimateMinutes: 30 },
    }], "2026-08-11T00:00:02.000Z");
    const reparent = await planner.pushUntrustedOperations(ORG, USER, [{
      entity: "block", idempotencyKey: "block:reparent", itemId: "block-1", kind: "update",
      at: at(3_000), payload: { itemId: "item-2" },
    }], "2026-08-11T00:00:03.000Z");

    expect(reparent.rejected[0]?.reason).toMatch(/cannot move from parent item item-1 to item-2/);
    expect((await fake.getPlannerBlock(ORG, USER, "block-1"))?.itemId).toBe("item-1");
  });

  it("rejects malformed operations individually while applying valid siblings", async () => {
    const outcome = await planner.pushUntrustedOperations(ORG, USER, [
      { entity: "block", idempotencyKey: "bad", itemId: "block-1", kind: "delete", at: at(1), payload: {} },
      itemOperation(),
    ], "2026-08-11T00:00:00.000Z");
    expect(outcome.accepted).toEqual(["item:create"]);
    expect(outcome.rejected).toEqual([{
      idempotencyKey: "bad", reason: "A block operation must be create or update.",
    }]);
  });

  it("pages block changes with an independent cursor instead of replaying all history", async () => {
    const parentStamp = at(1);
    fake.items.set(`${ORG}/${USER}/item-1`, {
      id: "item-1", origin: "owned", source: null,
      payload: { id: "item-1", origin: "owned", title: { value: "Parent", at: parentStamp } },
      revision: "1", updatedAt: "2026-08-11T00:00:00.000Z",
    });
    for (let index = 1; index <= 1001; index += 1) {
      fake.blocks.set(`${ORG}/${USER}/block-${index}`, {
        id: `block-${index}`, itemId: "item-1", scheduledFor: null,
        estimateMinutes: 30, actualMinutes: null, carriedOver: 0, completedAt: null,
        revision: String(index), updatedAt: at(index), deletedAt: null,
      });
    }

    const first = await planner.pullChanges(ORG, USER);
    expect(first.blocks).toHaveLength(1000);
    expect(first.cursor).toBe("p1:1:1000");
    const second = await planner.pullChanges(ORG, USER, first.cursor);
    expect(second.blocks.map((block) => block.id)).toEqual(["block-1001"]);
    expect(second.items).toEqual([]);
    expect(second.cursor).toBe("p1:1:1001");
  });
});
