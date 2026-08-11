/**
 * ADR-038 — pure Dashboard Planner adapter decisions.
 *
 * Keeping scope and retry selection outside the hook makes the two isolation
 * promises executable: queued text never crosses organizations, and a human
 * retry can include operations that automatic retry has intentionally stopped.
 */

import type {
  PlannerBlockWirePayload,
  PlannerConflictResolutionWirePayload,
  PlannerItemWirePayload,
  PlannerProvenance,
  PlannerPushOperation,
  PlannerWireHlc,
  PlannerWireStamped,
} from "@kinqs/brainrouter-types/planner";

export interface ApiPlannerItem {
  id: string;
  origin: "owned" | "mirrored";
  source?: string;
  fetchedAt?: string;
  provenance?: PlannerProvenance;
  title: PlannerWireStamped<string>;
  notes?: PlannerWireStamped<string>;
  dueDate?: PlannerWireStamped<string | null>;
  priority?: PlannerWireStamped<number>;
  completed?: PlannerWireStamped<boolean>;
  estimateMinutes?: number;
  blockedReason?: PlannerWireStamped<string | null>;
  deletedAt?: PlannerWireHlc;
  conflicts?: Record<string, unknown>;
  conflictResolutions?: Record<string, PlannerWireHlc | undefined>;
  deletionResolution?: { deleted: boolean; at: PlannerWireHlc };
}

export interface ApiPlannerBlock {
  id: string;
  itemId: string;
  scheduledFor?: string | null;
  estimateMinutes: number;
  actualMinutes?: number | null;
  carriedOver: number;
  completedAt?: string | null;
  updatedAt?: PlannerWireHlc;
  deletedAt?: PlannerWireHlc;
}

import { ATTEMPTS_BEFORE_SURFACING, describeSyncState } from "@kinqs/brainrouter-ui/planner";

export type DashboardPlannerOperation = PlannerPushOperation & {
  attempts?: number;
  lastError?: string;
};

/** Minimal Web Storage shape, kept injectable for durability/race tests. */
export interface PlannerStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RetryablePlannerOperation {
  idempotencyKey: string;
  attempts?: number;
}

const MAX_HLC_PHYSICAL = 8_640_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function validText(value: unknown, maxLength = 64_000): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function validIso(value: unknown): value is string {
  return validText(value, 100) && Number.isFinite(Date.parse(value));
}

function validStampedOr(
  value: unknown,
  validate: (candidate: unknown) => boolean,
): boolean {
  if (!isRecord(value)) return validate(value);
  return hasOnlyKeys(value, new Set(["value", "at", "seen"]))
    && Object.prototype.hasOwnProperty.call(value, "value")
    && validate(value.value)
    && isPlannerWireHlc(value.at)
    && (value.seen === undefined || (Array.isArray(value.seen)
      && value.seen.length <= 64
      && value.seen.every(isPlannerWireHlc)
      && new Set(value.seen.map((stamp) => stamp.deviceId)).size === value.seen.length));
}

function validProvenance(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["sourceId", "sourceLabel", "externalId", "sourceUrl", "fetchedAt"]))) {
    return false;
  }
  return validText(value.sourceId, 200)
    && value.sourceId.length > 0
    && validText(value.sourceLabel, 500)
    && value.sourceLabel.length > 0
    && validIso(value.fetchedAt)
    && (value.externalId === undefined || validText(value.externalId, 500))
    && (value.sourceUrl === undefined
      || (validText(value.sourceUrl, 4_000) && /^https:\/\//i.test(value.sourceUrl)));
}

function validItemPayload(kind: unknown, payload: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(payload, new Set([
    "id", "origin", "source", "fetchedAt", "externalId", "sourceLabel", "sourceUrl", "provenance",
    "title", "notes", "dueDate", "priority", "completed", "estimateMinutes", "blockedReason",
  ]))) return false;
  if (kind === "create" && payload.title === undefined) return false;
  return (payload.id === undefined || validText(payload.id, 500))
    && (payload.origin === undefined || payload.origin === "owned" || payload.origin === "mirrored")
    && (payload.source === undefined || validText(payload.source, 200))
    && (payload.fetchedAt === undefined || validIso(payload.fetchedAt))
    && (payload.externalId === undefined || validText(payload.externalId, 500))
    && (payload.sourceLabel === undefined || validText(payload.sourceLabel, 500))
    && (payload.sourceUrl === undefined
      || (validText(payload.sourceUrl, 4_000) && /^https:\/\//i.test(payload.sourceUrl)))
    && (payload.provenance === undefined || validProvenance(payload.provenance))
    && (payload.title === undefined || validStampedOr(payload.title, (value) => validText(value, 2_000)))
    && (payload.notes === undefined || validStampedOr(payload.notes, (value) => validText(value)))
    && (payload.dueDate === undefined
      || validStampedOr(payload.dueDate, (value) => value === null || validIso(value)))
    && (payload.priority === undefined
      || validStampedOr(payload.priority, (value) => typeof value === "number" && Number.isFinite(value)))
    && (payload.completed === undefined
      || validStampedOr(payload.completed, (value) => typeof value === "boolean"))
    && (payload.estimateMinutes === undefined
      || validStampedOr(payload.estimateMinutes, (value) => typeof value === "number" && value > 0 && Number.isFinite(value)))
    && (payload.blockedReason === undefined
      || validStampedOr(payload.blockedReason, (value) => value === null || validText(value, 2_000)));
}

function validBlockPayload(kind: unknown, payload: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(payload, new Set([
    "id", "itemId", "scheduledFor", "estimateMinutes", "actualMinutes", "carriedOver", "completedAt", "updatedAt",
  ]))) return false;
  if (kind === "create" && (payload.itemId === undefined || payload.estimateMinutes === undefined)) return false;
  return (payload.id === undefined || validText(payload.id, 500))
    && (payload.itemId === undefined || (validText(payload.itemId, 500) && payload.itemId.length > 0))
    && (payload.scheduledFor === undefined || payload.scheduledFor === null || validIso(payload.scheduledFor))
    && (payload.estimateMinutes === undefined
      || (typeof payload.estimateMinutes === "number" && payload.estimateMinutes > 0 && Number.isFinite(payload.estimateMinutes)))
    && (payload.actualMinutes === undefined || payload.actualMinutes === null
      || (typeof payload.actualMinutes === "number" && payload.actualMinutes >= 0 && Number.isFinite(payload.actualMinutes)))
    && (payload.carriedOver === undefined
      || (Number.isSafeInteger(payload.carriedOver) && Number(payload.carriedOver) >= 0))
    && (payload.completedAt === undefined || payload.completedAt === null || validIso(payload.completedAt))
    && (payload.updatedAt === undefined || isPlannerWireHlc(payload.updatedAt));
}

export function isPlannerWireHlc(value: unknown): value is PlannerWireHlc {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.physical)
    && Number(value.physical) >= 0
    && Number(value.physical) <= MAX_HLC_PHYSICAL
    && Number.isSafeInteger(value.logical)
    && Number(value.logical) >= 0
    && typeof value.deviceId === "string"
    && value.deviceId.length > 0
    && value.deviceId.length <= 200;
}

export function latestPlannerWireHlc(values: readonly PlannerWireHlc[]): PlannerWireHlc {
  return values.reduce((latest, candidate) => {
    if (candidate.physical !== latest.physical) {
      return candidate.physical > latest.physical ? candidate : latest;
    }
    if (candidate.logical !== latest.logical) {
      return candidate.logical > latest.logical ? candidate : latest;
    }
    return candidate.deviceId > latest.deviceId ? candidate : latest;
  }, { physical: 0, logical: 0, deviceId: "" });
}

export function tickPlannerWireHlc(
  observed: readonly PlannerWireHlc[],
  wallMs: number,
  localDeviceId: string,
): PlannerWireHlc {
  const latest = latestPlannerWireHlc(observed);
  const physical = Math.max(latest.physical, wallMs);
  return {
    physical,
    logical: physical === latest.physical ? latest.logical + 1 : 0,
    deviceId: localDeviceId,
  };
}

/** Reject malformed or stale localStorage entries before they reach rendering. */
export function isDashboardPlannerOperation(value: unknown): value is DashboardPlannerOperation {
  if (!isRecord(value)
    || typeof value.idempotencyKey !== "string"
    || value.idempotencyKey.length === 0
    || typeof value.itemId !== "string"
    || value.itemId.length === 0
    || !isPlannerWireHlc(value.at)
    || !isRecord(value.payload)
    || (value.attempts !== undefined && (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0))
    || (value.lastError !== undefined && !validText(value.lastError, 4_000))
    || (value.retryRequestedAt !== undefined && !validIso(value.retryRequestedAt))) {
    return false;
  }
  const entity = value.entity ?? "item";
  if (entity === "block") {
    return (value.kind === "create" || value.kind === "update")
      && validBlockPayload(value.kind, value.payload);
  }
  if (entity !== "item") return false;
  if (value.kind === "resolve_conflict") {
    if (value.payload.field === "deleted") {
      return hasOnlyKeys(value.payload, new Set(["field", "keep"]))
        && (value.payload.keep === "ours" || value.payload.keep === "theirs");
    }
    return hasOnlyKeys(value.payload, new Set(["field", "value"]))
      && (value.payload.field === "title" || value.payload.field === "notes")
      && validText(value.payload.value, value.payload.field === "notes" ? 64_000 : 2_000);
  }
  return (value.kind === "create"
      || value.kind === "update"
      || value.kind === "delete"
      || value.kind === "source_action")
    && validItemPayload(value.kind, value.payload);
}

export function plannerOutboxStorageKey(activeOrgId: string, subject: string): string {
  const org = activeOrgId || "default";
  return `br-planner-outbox:${subject}:${org}`;
}

function plannerOutboxEntryPrefix(storageKey: string): string {
  return `${storageKey}:operation:`;
}

function plannerOutboxEntryKey(storageKey: string, idempotencyKey: string): string {
  return `${plannerOutboxEntryPrefix(storageKey)}${encodeURIComponent(idempotencyKey)}`;
}

function parseStoredOperation(value: string | null): DashboardPlannerOperation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isDashboardPlannerOperation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compareOperation(a: DashboardPlannerOperation, b: DashboardPlannerOperation): number {
  if (a.at.physical !== b.at.physical) return a.at.physical - b.at.physical;
  if (a.at.logical !== b.at.logical) return a.at.logical - b.at.logical;
  const byDevice = a.at.deviceId.localeCompare(b.at.deviceId);
  return byDevice || a.idempotencyKey.localeCompare(b.idempotencyKey);
}

/**
 * Read both the former whole-array format and collision-free per-operation
 * entries. Per-operation keys prevent two tabs from replacing each other's
 * queue; unique idempotency keys make merging deterministic.
 */
export function readPlannerOutbox(
  storage: PlannerStorage,
  storageKey: string,
): DashboardPlannerOperation[] {
  const byId = new Map<string, DashboardPlannerOperation>();
  const legacy = storage.getItem(storageKey);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as unknown;
      if (Array.isArray(parsed)) {
        for (const candidate of parsed) {
          if (isDashboardPlannerOperation(candidate)) byId.set(candidate.idempotencyKey, candidate);
        }
      }
    } catch { /* malformed legacy state is ignored, never executed */ }
  }
  const prefix = plannerOutboxEntryPrefix(storageKey);
  const count = storage.length;
  for (let index = 0; index < count; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const operation = parseStoredOperation(storage.getItem(key));
    if (operation) byId.set(operation.idempotencyKey, operation);
  }
  return [...byId.values()].sort(compareOperation);
}

function persistOne(
  storage: PlannerStorage,
  storageKey: string,
  operation: DashboardPlannerOperation,
): void {
  const key = plannerOutboxEntryKey(storageKey, operation.idempotencyKey);
  const serialized = JSON.stringify(operation);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error("The browser could not verify the saved Planner change.");
  }
}

/** Persist before optimistic rendering; a failure leaves the visible model unchanged. */
export function persistPlannerOperations(
  storage: PlannerStorage,
  storageKey: string,
  operations: readonly DashboardPlannerOperation[],
): DashboardPlannerOperation[] {
  for (const operation of operations) persistOne(storage, storageKey, operation);
  return readPlannerOutbox(storage, storageKey);
}

/** Remove only acknowledged batch members; unrelated tabs' entries survive. */
export function removePlannerOperations(
  storage: PlannerStorage,
  storageKey: string,
  idempotencyKeys: ReadonlySet<string>,
): DashboardPlannerOperation[] {
  for (const idempotencyKey of idempotencyKeys) {
    const key = plannerOutboxEntryKey(storageKey, idempotencyKey);
    storage.removeItem(key);
    if (storage.getItem(key) !== null) {
      throw new Error("The browser could not remove an acknowledged Planner change.");
    }
  }
  // The old array may still be written by a tab from the previous release.
  const legacy = storage.getItem(storageKey);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as unknown;
      const kept = Array.isArray(parsed)
        ? parsed.filter((candidate) => !isDashboardPlannerOperation(candidate)
          || !idempotencyKeys.has(candidate.idempotencyKey))
        : [];
      if (kept.length > 0) storage.setItem(storageKey, JSON.stringify(kept));
      else storage.removeItem(storageKey);
    } catch {
      storage.removeItem(storageKey);
    }
  }
  return readPlannerOutbox(storage, storageKey);
}

/** One-time lossless migration from the replace-whole-array queue. */
export function migratePlannerOutbox(
  storage: PlannerStorage,
  storageKey: string,
): DashboardPlannerOperation[] {
  const operations = readPlannerOutbox(storage, storageKey);
  for (const operation of operations) persistOne(storage, storageKey, operation);
  storage.removeItem(storageKey);
  return readPlannerOutbox(storage, storageKey);
}

/** Exact disjoint partition of the batch, or a reason to keep every operation. */
export function invalidPlannerPushOutcome(
  batch: readonly DashboardPlannerOperation[],
  outcome: unknown,
): string | null {
  if (!isRecord(outcome) || !Array.isArray(outcome.accepted) || !Array.isArray(outcome.rejected)) {
    return "The server returned an invalid Planner acknowledgement.";
  }
  const expected = new Set(batch.map((operation) => operation.idempotencyKey));
  if (expected.size !== batch.length) return "The Planner batch contains duplicate idempotency keys.";
  const seen = new Set<string>();
  for (const key of outcome.accepted) {
    if (typeof key !== "string" || !expected.has(key) || seen.has(key)) {
      return "The server acknowledged an unknown or duplicate Planner operation.";
    }
    seen.add(key);
  }
  for (const candidate of outcome.rejected) {
    if (!isRecord(candidate)
      || typeof candidate.idempotencyKey !== "string"
      || !expected.has(candidate.idempotencyKey)
      || seen.has(candidate.idempotencyKey)
      || typeof candidate.reason !== "string"
      || candidate.reason.trim().length === 0) {
      return "The server rejected an unknown or duplicate Planner operation.";
    }
    seen.add(candidate.idempotencyKey);
  }
  return seen.size === expected.size
    ? null
    : "The server omitted a Planner operation from its acknowledgement.";
}

/** Highest embedded peer stamp, not merely the API process wall clock. */
export function latestPlannerEnvelopeClock(
  items: readonly ApiPlannerItem[],
  blocks: readonly ApiPlannerBlock[],
  serverClock?: PlannerWireHlc,
): PlannerWireHlc | null {
  const stamps: PlannerWireHlc[] = serverClock ? [serverClock] : [];
  const add = (candidate: unknown): void => {
    if (isPlannerWireHlc(candidate)) stamps.push(candidate);
  };
  for (const item of items) {
    add(item.title.at);
    add(item.notes?.at);
    add(item.dueDate?.at);
    add(item.priority?.at);
    add(item.completed?.at);
    add(item.blockedReason?.at);
    add(item.deletedAt);
    add(item.deletionResolution?.at);
    for (const resolution of Object.values(item.conflictResolutions ?? {})) add(resolution);
    for (const conflict of Object.values(item.conflicts ?? {})) {
      if (!isRecord(conflict)) continue;
      add(conflict.oursAt);
      add(conflict.theirsAt);
    }
  }
  for (const block of blocks) {
    add(block.updatedAt);
    add(block.deletedAt);
  }
  return stamps.length > 0 ? latestPlannerWireHlc(stamps) : null;
}

export function selectPlannerOperationsForDrain<T extends RetryablePlannerOperation>(
  operations: readonly T[],
  attemptsBeforeAttention: number,
  explicitIds?: ReadonlySet<string>,
): T[] {
  return operations.filter((operation) => explicitIds
    ? explicitIds.has(operation.idempotencyKey)
    : (operation.attempts ?? 0) < attemptsBeforeAttention);
}

export function plannerPushBatches<T>(operations: readonly T[], limit = 200): T[][] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Planner push batch size must be positive.");
  const batches: T[][] = [];
  for (let offset = 0; offset < operations.length; offset += limit) {
    batches.push(operations.slice(offset, offset + limit));
  }
  return batches;
}

function stamped<T>(value: T, at: PlannerWireHlc, seen?: PlannerWireHlc[]): PlannerWireStamped<T> {
  return { value, at, ...(seen ? { seen } : {}) };
}

function primitive<T>(value: T | PlannerWireStamped<T>): T {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "value")
    ? value.value as T
    : value as T;
}

function seenOf<T>(value: T | PlannerWireStamped<T>): PlannerWireHlc[] | undefined {
  return isRecord(value) && Array.isArray(value.seen)
    ? value.seen.filter(isPlannerWireHlc)
    : undefined;
}

function replayItemPatch(
  item: ApiPlannerItem,
  payload: PlannerItemWirePayload,
  at: PlannerWireHlc,
): ApiPlannerItem {
  return {
    ...item,
    ...(payload.origin ? { origin: payload.origin } : {}),
    ...(payload.source !== undefined ? { source: payload.source } : {}),
    ...(payload.fetchedAt !== undefined ? { fetchedAt: payload.fetchedAt } : {}),
    ...(payload.provenance !== undefined ? { provenance: payload.provenance } : {}),
    ...(payload.title !== undefined ? { title: stamped(primitive(payload.title), at, seenOf(payload.title)) } : {}),
    ...(payload.notes !== undefined ? { notes: stamped(primitive(payload.notes), at, seenOf(payload.notes)) } : {}),
    ...(payload.dueDate !== undefined ? { dueDate: stamped(primitive(payload.dueDate), at) } : {}),
    ...(payload.priority !== undefined ? { priority: stamped(primitive(payload.priority), at) } : {}),
    ...(payload.completed !== undefined ? { completed: stamped(primitive(payload.completed), at) } : {}),
    ...(payload.estimateMinutes !== undefined
      ? { estimateMinutes: primitive(payload.estimateMinutes) }
      : {}),
    ...(payload.blockedReason !== undefined
      ? { blockedReason: stamped(primitive(payload.blockedReason), at) }
      : {}),
  };
}

function replayBlockPatch(
  block: ApiPlannerBlock,
  payload: PlannerBlockWirePayload,
  at: PlannerWireHlc,
): ApiPlannerBlock {
  return {
    ...block,
    ...(payload.itemId !== undefined ? { itemId: payload.itemId } : {}),
    ...(payload.scheduledFor !== undefined ? { scheduledFor: payload.scheduledFor } : {}),
    ...(payload.estimateMinutes !== undefined ? { estimateMinutes: payload.estimateMinutes } : {}),
    ...(payload.actualMinutes !== undefined ? { actualMinutes: payload.actualMinutes } : {}),
    ...(payload.carriedOver !== undefined ? { carriedOver: payload.carriedOver } : {}),
    ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
    updatedAt: at,
  };
}

/**
 * Project durable, not-yet-accepted operations over a server snapshot. This is
 * the Dashboard's local-first read model: polling and reloads cannot hide work
 * that is still safely queued in localStorage.
 */
export function replayPlannerOutbox(
  serverItems: readonly ApiPlannerItem[],
  serverBlocks: readonly ApiPlannerBlock[],
  operations: readonly DashboardPlannerOperation[],
): { items: ApiPlannerItem[]; blocks: ApiPlannerBlock[] } {
  let items = serverItems.filter((item) => !item.deletedAt).map((item) => ({ ...item }));
  let blocks = serverBlocks.filter((block) => !block.deletedAt).map((block) => ({ ...block }));

  for (const operation of operations) {
    if ((operation.entity ?? "item") === "block") {
      const payload = operation.payload as PlannerBlockWirePayload;
      const index = blocks.findIndex((block) => block.id === operation.itemId);
      if (operation.kind === "create" && index < 0 && payload.itemId && payload.estimateMinutes) {
        blocks.push(replayBlockPatch({
          id: operation.itemId,
          itemId: payload.itemId,
          estimateMinutes: payload.estimateMinutes,
          carriedOver: payload.carriedOver ?? 0,
        }, payload, operation.at));
      } else if (index >= 0) {
        blocks[index] = replayBlockPatch(blocks[index], payload, operation.at);
      }
      continue;
    }

    const payload = operation.payload as PlannerItemWirePayload;
    const index = items.findIndex((item) => item.id === operation.itemId);
    if (operation.kind === "delete") {
      items = items.filter((item) => item.id !== operation.itemId);
      blocks = blocks.filter((block) => block.itemId !== operation.itemId);
      continue;
    }
    if (operation.kind === "source_action") continue;
    if (operation.kind === "resolve_conflict" && index >= 0) {
      const resolution = operation.payload as PlannerConflictResolutionWirePayload;
      const conflicts = { ...(items[index].conflicts ?? {}) };
      delete conflicts[resolution.field];
      if (resolution.field === "deleted") {
        const deleted = resolution.keep === "ours";
        if (deleted) {
          items.splice(index, 1);
          blocks = blocks.filter((block) => block.itemId !== operation.itemId);
        } else {
          items[index] = {
            ...items[index],
            deletedAt: undefined,
            deletionResolution: { deleted: false, at: operation.at },
            ...(Object.keys(conflicts).length > 0 ? { conflicts } : { conflicts: undefined }),
          };
        }
        continue;
      }
      items[index] = {
        ...items[index],
        ...(resolution.field === "title"
          ? { title: stamped(resolution.value, operation.at) }
          : { notes: stamped(resolution.value, operation.at) }),
        ...(Object.keys(conflicts).length > 0 ? { conflicts } : { conflicts: undefined }),
      };
      continue;
    }
    if (operation.kind === "create" && index < 0 && payload.title !== undefined) {
      const title = primitive(payload.title);
      items.unshift(replayItemPatch({
        id: operation.itemId,
        origin: payload.origin ?? "owned",
        title: stamped(title, operation.at),
      }, payload, operation.at));
    } else if (index >= 0) {
      items[index] = replayItemPatch(items[index], payload, operation.at);
    }
  }

  const visibleIds = new Set(items.map((item) => item.id));
  return {
    items,
    blocks: blocks.filter((block) => visibleIds.has(block.itemId)),
  };
}

/**
 * The queue, as the shared sync control renders it.
 *
 * Pure, and here rather than inside the hook's `useMemo` for the reason
 * `scheduledTodayIds` moved: a rule nothing can call is a rule nothing can pin.
 * Reverting the label to a hand-built string used to pass every test in the
 * repository, which is how this host came to say "waiting to sync" about a queue
 * that was permanently rejected while the desktop said so.
 */
export function plannerSyncProjection(
  outbox: readonly DashboardPlannerOperation[],
  context: {
    readonly itemTitle: ReadonlyMap<string, string>;
    readonly blockItem: ReadonlyMap<string, string>;
    readonly now: number;
    readonly ageLabel: (ms: number) => string;
  },
): { label: string; pendingCount: number; issues: PlannerSyncIssueProjection[] } {
  return {
    // Core's rule through the shared door — never a third copy of the wording.
    label: describeSyncState({ operations: outbox }),
    pendingCount: outbox.length,
    issues: outbox.map((operation) => {
      const entity = operation.entity ?? "item";
      const parentItemId = entity === "block" ? context.blockItem.get(operation.itemId) : operation.itemId;
      return {
        id: operation.idempotencyKey,
        entity,
        itemId: parentItemId ?? operation.itemId,
        itemTitle: parentItemId ? context.itemTitle.get(parentItemId) : undefined,
        action: operation.kind,
        createdAt: new Date(operation.at.physical).toISOString(),
        ageLabel: context.ageLabel(context.now - operation.at.physical),
        attempts: operation.attempts ?? 0,
        lastError: operation.lastError,
        stuck: (operation.attempts ?? 0) >= ATTEMPTS_BEFORE_SURFACING,
      };
    }),
  };
}

export interface PlannerSyncIssueProjection {
  id: string;
  entity: "item" | "block";
  itemId: string;
  itemTitle?: string;
  action: DashboardPlannerOperation["kind"];
  createdAt: string;
  ageLabel: string;
  attempts: number;
  lastError?: string;
  stuck: boolean;
}
