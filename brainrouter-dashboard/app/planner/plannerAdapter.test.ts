import test from "node:test";
import assert from "node:assert/strict";

import {
  isDashboardPlannerOperation,
  plannerSyncProjection,
  invalidPlannerPushOutcome,
  latestPlannerWireHlc,
  latestPlannerEnvelopeClock,
  migratePlannerOutbox,
  persistPlannerOperations,
  plannerOutboxStorageKey,
  plannerPushBatches,
  readPlannerOutbox,
  removePlannerOperations,
  replayPlannerOutbox,
  selectPlannerOperationsForDrain,
  tickPlannerWireHlc,
} from "./plannerAdapter";
import type { PlannerPushOperation, PlannerWireHlc } from "@kinqs/brainrouter-types/planner";
import type { PlannerStorage } from "./plannerAdapter";

const at = (physical: number): PlannerWireHlc => ({ physical, logical: 0, deviceId: "web-test" });

class MemoryStorage implements PlannerStorage {
  public readonly values = new Map<string, string>();
  public throwOnSet = false;
  public get length(): number { return this.values.size; }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error("quota exceeded");
    this.values.set(key, value);
  }
  public removeItem(key: string): void { this.values.delete(key); }
}

test("ADR-038 scopes planner outboxes by both subject and active organization", () => {
  assert.notEqual(
    plannerOutboxStorageKey("org-a", "person-1"),
    plannerOutboxStorageKey("org-b", "person-1"),
  );
  assert.notEqual(
    plannerOutboxStorageKey("org-a", "person-1"),
    plannerOutboxStorageKey("org-a", "person-2"),
  );
});

test("ADR-038 automatic retry stops stuck work while explicit retry includes it", () => {
  const operations = [
    { idempotencyKey: "pending", attempts: 1 },
    { idempotencyKey: "stuck", attempts: 5 },
  ];
  assert.deepEqual(
    selectPlannerOperationsForDrain(operations, 5).map((operation) => operation.idempotencyKey),
    ["pending"],
  );
  assert.deepEqual(
    selectPlannerOperationsForDrain(operations, 5, new Set(["stuck"])),
    [operations[1]],
  );
});

test("ADR-038 drains more than the server limit as bounded batches", () => {
  const operations = Array.from({ length: 401 }, (_, index) => ({ idempotencyKey: `op-${index}` }));
  const batches = plannerPushBatches(operations, 200);
  assert.deepEqual(batches.map((batch) => batch.length), [200, 200, 1]);
  assert.deepEqual(batches.flat(), operations);
});

test("ADR-038 rejects malformed durable outbox clocks at the storage boundary", () => {
  assert.equal(isDashboardPlannerOperation({
    idempotencyKey: "bad",
    itemId: "item-1",
    kind: "update",
    at: { physical: "yesterday", logical: 0, deviceId: "web-test" },
    payload: { completed: true },
  }), false);
  assert.equal(isDashboardPlannerOperation({
    idempotencyKey: "good",
    itemId: "item-1",
    entity: "item",
    kind: "update",
    at: at(10),
    payload: { completed: true },
  }), true);
  assert.equal(isDashboardPlannerOperation({
    idempotencyKey: "bad-title",
    itemId: "item-2",
    entity: "item",
    kind: "create",
    at: at(11),
    payload: { title: { unexpected: "object" } },
  }), false);
});

test("ADR-038 durable browser clocks advance beyond a fast remote conflict", () => {
  const remote = { physical: 9_000_000_000_000, logical: 7, deviceId: "remote" };
  const persisted = { physical: remote.physical, logical: 5, deviceId: "web-old" };
  assert.deepEqual(latestPlannerWireHlc([persisted, remote]), remote);
  assert.deepEqual(
    tickPlannerWireHlc([persisted, remote], 1_000, "web-local"),
    { physical: remote.physical, logical: 8, deviceId: "web-local" },
  );
});

test("ADR-038 replays pending local work over every server refresh", () => {
  const operations: PlannerPushOperation[] = [
    {
      idempotencyKey: "create-local",
      itemId: "local",
      entity: "item",
      kind: "create",
      at: at(20),
      payload: { title: "Offline capture" },
    },
    {
      idempotencyKey: "complete-server",
      itemId: "server",
      entity: "item",
      kind: "update",
      at: at(21),
      payload: { completed: true },
    },
    {
      idempotencyKey: "move-server-block",
      itemId: "block-server",
      entity: "block",
      kind: "update",
      at: at(22),
      payload: { itemId: "server", scheduledFor: "2026-08-11T11:00:00.000Z" },
    },
  ];
  const projected = replayPlannerOutbox([
    { id: "server", origin: "owned", title: { value: "Server item", at: at(1) } },
  ], [
    { id: "block-server", itemId: "server", estimateMinutes: 60, carriedOver: 0 },
  ], operations);

  assert.deepEqual(projected.items.map((item) => item.id), ["local", "server"]);
  assert.equal(projected.items.find((item) => item.id === "server")?.completed?.value, true);
  assert.equal(projected.blocks[0]?.scheduledFor, "2026-08-11T11:00:00.000Z");
});

test("ADR-038 pending deletion hides both the item and its blocks", () => {
  const projected = replayPlannerOutbox([
    { id: "delete-me", origin: "owned", title: { value: "Gone", at: at(1) } },
    { id: "keep-me", origin: "owned", title: { value: "Keep", at: at(1) } },
  ], [
    { id: "orphan", itemId: "delete-me", estimateMinutes: 30, carriedOver: 0 },
    { id: "keep-block", itemId: "keep-me", estimateMinutes: 30, carriedOver: 0 },
  ], [{
    idempotencyKey: "delete",
    itemId: "delete-me",
    entity: "item",
    kind: "delete",
    at: at(30),
    payload: {},
  }]);

  assert.deepEqual(projected.items.map((item) => item.id), ["keep-me"]);
  assert.deepEqual(projected.blocks.map((block) => block.id), ["keep-block"]);
});

test("ADR-038 pending conflict resolution stays resolved across polling", () => {
  const projected = replayPlannerOutbox([{
    id: "conflicted",
    origin: "owned",
    title: { value: "Current", at: at(1) },
    conflicts: { title: { ours: "Mine", theirs: "Theirs" } },
  }], [], [{
    idempotencyKey: "resolve",
    itemId: "conflicted",
    entity: "item",
    kind: "resolve_conflict",
    at: at(50),
    payload: { field: "title", value: "Theirs" },
  }]);

  assert.equal(projected.items[0]?.title.value, "Theirs");
  assert.deepEqual(projected.items[0]?.conflicts, undefined);
});

test("ADR-038 pending delete-versus-edit choices do not resurrect on polling", () => {
  const server = [{
    id: "conflicted", origin: "owned" as const, title: { value: "Edited", at: at(2) },
    conflicts: { deleted: { ours: "deleted", theirs: "edited" } },
  }];
  const keepEdit = replayPlannerOutbox(server, [], [{
    idempotencyKey: "keep-edit", itemId: "conflicted", entity: "item", kind: "resolve_conflict",
    at: at(50), payload: { field: "deleted", keep: "theirs" },
  }]);
  assert.equal(keepEdit.items[0]?.title.value, "Edited");
  assert.equal(keepEdit.items[0]?.deletionResolution?.deleted, false);
  assert.equal(keepEdit.items[0]?.conflicts, undefined);

  const keepDelete = replayPlannerOutbox(server, [{
    id: "block", itemId: "conflicted", estimateMinutes: 30, carriedOver: 0,
  }], [{
    idempotencyKey: "keep-delete", itemId: "conflicted", entity: "item", kind: "resolve_conflict",
    at: at(51), payload: { field: "deleted", keep: "ours" },
  }]);
  assert.deepEqual(keepDelete.items, []);
  assert.deepEqual(keepDelete.blocks, []);
});

test("ADR-038 pending actual time remains visible until the block update is accepted", () => {
  const projected = replayPlannerOutbox([{
    id: "item", origin: "owned", title: { value: "Work", at: at(1) },
  }], [{
    id: "block", itemId: "item", estimateMinutes: 30, carriedOver: 0,
  }], [{
    idempotencyKey: "actual", itemId: "block", entity: "block", kind: "update", at: at(60),
    payload: { itemId: "item", actualMinutes: 42, completedAt: "2026-08-11T02:00:00.000Z" },
  }]);
  assert.equal(projected.blocks[0]?.actualMinutes, 42);
  assert.equal(projected.blocks[0]?.completedAt, "2026-08-11T02:00:00.000Z");
});

test("ADR-038 stores operations independently so two tabs cannot replace each other's queue", () => {
  const storage = new MemoryStorage();
  const key = plannerOutboxStorageKey("org-a", "person-a");
  const first = {
    idempotencyKey: "uuid-a", itemId: "a", entity: "item" as const, kind: "create" as const,
    at: at(10), payload: { title: "First tab" },
  };
  const second = {
    idempotencyKey: "uuid-b", itemId: "b", entity: "item" as const, kind: "create" as const,
    at: at(11), payload: { title: "Second tab" },
  };
  persistPlannerOperations(storage, key, [first]);
  persistPlannerOperations(storage, key, [second]);
  assert.deepEqual(readPlannerOutbox(storage, key).map((operation) => operation.idempotencyKey), ["uuid-a", "uuid-b"]);

  removePlannerOperations(storage, key, new Set(["uuid-a"]));
  assert.deepEqual(readPlannerOutbox(storage, key).map((operation) => operation.idempotencyKey), ["uuid-b"]);
});

test("ADR-038 refuses an optimistic change when durable storage fails", () => {
  const storage = new MemoryStorage();
  storage.throwOnSet = true;
  assert.throws(() => persistPlannerOperations(storage, "scope", [{
    idempotencyKey: "uuid", itemId: "a", entity: "item", kind: "create",
    at: at(10), payload: { title: "Must stay visible only if durable" },
  }]), /quota exceeded/);
  assert.deepEqual(readPlannerOutbox(storage, "scope"), []);
});

test("ADR-038 migrates the former array queue without dropping either operation", () => {
  const storage = new MemoryStorage();
  const key = "legacy";
  storage.setItem(key, JSON.stringify([
    { idempotencyKey: "one", itemId: "a", kind: "create", at: at(1), payload: { title: "A" } },
    { idempotencyKey: "two", itemId: "b", kind: "create", at: at(2), payload: { title: "B" } },
  ]));
  assert.deepEqual(migratePlannerOutbox(storage, key).map((operation) => operation.idempotencyKey), ["one", "two"]);
  assert.equal(storage.getItem(key), null);
});

test("ADR-038 accepts only an exact disjoint push outcome", () => {
  const batch = [{
    idempotencyKey: "one", itemId: "a", entity: "item" as const, kind: "update" as const,
    at: at(1), payload: { completed: true },
  }];
  assert.equal(invalidPlannerPushOutcome(batch, { accepted: ["one"], rejected: [] }), null);
  assert.match(invalidPlannerPushOutcome(batch, { accepted: [], rejected: [] }) ?? "", /omitted/);
  assert.match(invalidPlannerPushOutcome(batch, { accepted: ["other"], rejected: [] }) ?? "", /unknown/);
  assert.match(invalidPlannerPushOutcome(batch, { accepted: ["one", "one"], rejected: [] }) ?? "", /duplicate/);
});

test("ADR-038 observes future record stamps in addition to the server wall clock", () => {
  const latest = latestPlannerEnvelopeClock([{
    id: "future", origin: "owned", title: { value: "Future", at: at(9_000) },
    conflicts: { title: { oursAt: at(9_100), theirsAt: at(9_200) } },
    deletionResolution: { deleted: false, at: at(9_250) },
  }], [{
    id: "block", itemId: "future", estimateMinutes: 30, carriedOver: 0,
    updatedAt: at(9_300),
  }], at(100));
  assert.deepEqual(latest, at(9_300));
});

test("the sync projection says a wedged queue is wedged, in Core's words", () => {
  const wedged = plannerSyncProjection(
    [
      { idempotencyKey: "k1", itemId: "i1", kind: "update", at: { physical: 1_000, logical: 0, deviceId: "d" }, attempts: 7, lastError: "HTTP 500" },
      { idempotencyKey: "k2", itemId: "i2", kind: "update", at: { physical: 1_000, logical: 0, deviceId: "d" }, attempts: 7 },
    ] as never,
    { itemTitle: new Map([["i1", "Ship it"]]), blockItem: new Map(), now: 61_000, ageLabel: () => "1m" },
  );

  // ADR-038 §6: with sync failing, the page says so. This host used to print
  // "waiting to sync" here whatever the attempt count, and the only other signal
  // was an aria-hidden dot.
  assert.equal(wedged.label, "2 changes could not be sent — open sync to see why.");
  assert.equal(wedged.issues[0]?.stuck, true);
  assert.equal(wedged.issues[0]?.itemTitle, "Ship it");

  const waiting = plannerSyncProjection(
    [{ idempotencyKey: "k3", itemId: "i3", kind: "update", at: { physical: 1_000, logical: 0, deviceId: "d" } }] as never,
    { itemTitle: new Map(), blockItem: new Map(), now: 61_000, ageLabel: () => "1m" },
  );
  assert.equal(waiting.label, "1 change waiting to sync.");
  assert.equal(waiting.issues[0]?.stuck, false);

  // A retry already asked for is not offered again. The visual gate caught this:
  // widening the control to "anything that failed once" left it on screen after
  // the click, so the row looked identical before and after and the only
  // feedback was that nothing had happened.
  const asked = plannerSyncProjection(
    [{ idempotencyKey: "k4", itemId: "i4", kind: "update", at: { physical: 1_000, logical: 0, deviceId: "d" }, attempts: 5, retryRequestedAt: "2026-08-11T10:00:00.000Z" }] as never,
    { itemTitle: new Map(), blockItem: new Map(), now: 61_000, ageLabel: () => "1m" },
  );
  assert.equal(asked.issues[0]?.retryRequested, true);
});
