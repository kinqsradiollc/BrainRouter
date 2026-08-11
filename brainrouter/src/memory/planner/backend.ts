/**
 * Planner backend — the data plane behind `/api/planner` (migrations 051/058/059).
 *
 * ADR-028 D9: the planner is PERSONAL. Unlike Track, which is org-collaborative,
 * one person's day is not another's, so `user_id` is part of the key rather than
 * an author column — cross-user reads are impossible by construction rather than
 * by a filter someone might forget to write.
 *
 * D11's asymmetry is the important part of this file: **the server merges too.**
 * A client that is behind must not win simply by pushing last, so a push applies
 * the D4 rules against the server's current state rather than accepting the
 * payload wholesale. That means the merge functions live in core and BOTH halves
 * call them — one implementation, so the two sides cannot drift into disagreeing
 * about who won. ADR-038 D4 adds entity-discriminated item/block operations
 * and targeted retry without changing those local-first ordering rules.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ConnectorDocumentRecord, ConnectorSource } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../engine.js";
import {
  causalValue, createConnectorIssueSourceAdapter, mergeOwnedItem, refreshMirrored, compareHlc, validatePlannerOperation,
  type PlannerItem, type Hlc, type TimeBlock,
  type PlannerProjectionSummary,
  type PlannerPushOperation, type PlannerPushOutcome,
  type ValidatedPlannerItemOperation, type ValidatedPlannerItemMutationOperation,
  type ValidatedPlannerConflictResolutionOperation, type ValidatedPlannerBlockOperation,
} from "@kinqs/brainrouter-core/planner";

export interface PlannerRow {
  id: string;
  origin: "owned" | "mirrored";
  source: string | null;
  payload: PlannerItem;
  revision: string;
  updatedAt: string;
}

export interface PlannerBlockRow {
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

export type PushOperation = PlannerPushOperation;
export type PushOutcome = PlannerPushOutcome;

interface PlannerMutationStore {
  getPlannerItem(orgId: string, userId: string, id: string): Promise<PlannerRow | null>;
  /** Takes the denormalized persistence row, with the stamped item as payload. */
  upsertPlannerItem(orgId: string, userId: string, row: {
    id: string;
    origin: "owned" | "mirrored";
    source: string | null;
    payload: PlannerItem;
    dueDate: string | null;
    completed: boolean;
    deletedAtHlc: string | null;
  }): Promise<PlannerRow>;
  getPlannerBlock(orgId: string, userId: string, id: string): Promise<PlannerBlockRow | null>;
  upsertPlannerBlock(orgId: string, userId: string, block: PlannerBlockRow): Promise<PlannerBlockRow>;
  tombstonePlannerBlocksForItem(orgId: string, userId: string, itemId: string, deletedAt: Hlc): Promise<number>;
  getOperationReceipt(orgId: string, userId: string, key: string): Promise<{
    itemId: string;
    entity: "item" | "block" | null;
    operationKind: string | null;
    fingerprint: string | null;
  } | null>;
  recordOperationApplied(
    orgId: string,
    userId: string,
    key: string,
    itemId: string,
    entity: "item" | "block",
    operationKind: string,
    fingerprint: string,
  ): Promise<void>;
}

interface PlannerStore extends PlannerMutationStore {
  withPlannerMutation<T>(
    orgId: string,
    userId: string,
    fn: (locked: PlannerMutationStore) => Promise<T>,
  ): Promise<T>;
  listPlannerItemsSince(orgId: string, userId: string, since?: string): Promise<PlannerRow[]>;
  listPlannerBlocks(orgId: string, userId: string): Promise<PlannerBlockRow[]>;
  listPlannerBlocksSince(orgId: string, userId: string, since?: string): Promise<PlannerBlockRow[]>;
}
const store = (): PlannerStore => memoryEngine.store as unknown as PlannerStore;

/**
 * Everything changed for this user since the client's cursor.
 *
 * `since` is a server revision, not a timestamp. Timestamps would be wrong here
 * for the same reason D3 gives for the HLC: two rows written in the same
 * millisecond are indistinguishable, and a client that resumes on a timestamp
 * boundary silently skips whichever one sorted second.
 */
export async function pullChanges(
  orgId: string,
  userId: string,
  since?: string,
): Promise<{ items: PlannerItem[]; blocks: TimeBlock[]; cursor: string }> {
  const previous = decodePlannerCursor(since);
  const [rows, blockRows] = await Promise.all([
    store().listPlannerItemsSince(orgId, userId, previous.items),
    store().listPlannerBlocksSince(orgId, userId, previous.blocks),
  ]);
  // Advance only through the last row actually returned. If either query hits
  // its 1000-row bound, the next pull resumes with row 1001 instead of skipping
  // to a MAX(revision) observed after the page was read.
  const itemCursor = rows.at(-1)?.revision ?? previous.items;
  const blockCursor = blockRows.at(-1)?.revision ?? previous.blocks;
  return {
    items: rows.map((r) => r.payload),
    blocks: blockRows.map(toTimeBlock),
    cursor: encodePlannerCursor(itemCursor, blockCursor),
  };
}

interface PlannerCursor {
  items: string;
  blocks: string;
}

/** Opaque v1 cursor; legacy numeric item cursors trigger a one-time block page. */
export function decodePlannerCursor(cursor?: string): PlannerCursor {
  if (!cursor) return { items: "0", blocks: "0" };
  const composite = /^p1:(\d+):(\d+)$/.exec(cursor);
  if (composite) return { items: composite[1]!, blocks: composite[2]! };
  if (/^\d+$/.test(cursor)) return { items: cursor, blocks: "0" };
  return { items: "0", blocks: "0" };
}

function encodePlannerCursor(items: string, blocks: string): string {
  return `p1:${items}:${blocks}`;
}

function toTimeBlock(row: PlannerBlockRow): TimeBlock {
  return {
    id: row.id,
    itemId: row.itemId,
    ...(row.scheduledFor ? { scheduledFor: row.scheduledFor } : {}),
    estimateMinutes: row.estimateMinutes,
    ...(row.actualMinutes !== null ? { actualMinutes: row.actualMinutes } : {}),
    carriedOver: row.carriedOver,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    updatedAt: row.updatedAt,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
  };
}

function stampItemPatch(
  existing: PlannerItem | undefined,
  op: ValidatedPlannerItemMutationOperation,
): PlannerItem | null {
  const patch = op.payload;
  const stamped = <T>(value: T, seen?: Hlc[]) => ({
    value,
    at: op.at,
    ...(seen ? { seen } : {}),
  });
  const title = patch.title ?? existing?.title.value;
  if (title === undefined) return null;
  const source = patch.source ?? patch.provenance?.sourceId ?? existing?.source;
  const fetchedAt = patch.fetchedAt ?? patch.provenance?.fetchedAt ?? existing?.fetchedAt;
  return {
    ...(existing ?? {}),
    id: op.itemId,
    origin: patch.origin ?? existing?.origin ?? (source ? "mirrored" : "owned"),
    ...(source ? { source } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(patch.provenance ? { provenance: patch.provenance } : {}),
    title: patch.title !== undefined ? stamped(patch.title, patch.titleSeen) : existing!.title,
    ...(patch.notes !== undefined ? { notes: stamped(patch.notes, patch.notesSeen) } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: stamped(patch.dueDate) } : {}),
    ...(patch.priority !== undefined ? { priority: stamped(patch.priority) } : {}),
    ...(patch.completed !== undefined ? { completed: stamped(patch.completed) } : {}),
    ...(patch.estimateMinutes !== undefined
      ? { estimateMinutes: patch.estimateMinutes, estimateUpdatedAt: op.at }
      : {}),
    ...(patch.blockedReason !== undefined ? { blockedReason: stamped(patch.blockedReason) } : {}),
    ...(op.kind === "delete" ? { deletedAt: op.at } : {}),
  };
}

async function applyItemOperation(
  targetStore: PlannerMutationStore,
  orgId: string,
  userId: string,
  op: ValidatedPlannerItemOperation,
  nowIso: string,
): Promise<string | null> {
  if (op.kind === "resolve_conflict") {
    return applyConflictResolution(targetStore, orgId, userId, op);
  }
  const existing = await targetStore.getPlannerItem(orgId, userId, op.itemId);
  if (!existing && op.kind !== "create") return "The planner item does not exist.";
  const incoming = stampItemPatch(existing?.payload, op);
  if (!incoming || (op.kind === "create" && !incoming.title.value.trim())) {
    return "A created item needs a title.";
  }

  if (op.kind === "source_action") {
    return existing?.payload.origin === "mirrored"
      ? "This connected source has no action adapter configured; no local change was applied."
      : "Source actions only apply to items owned by a connected source.";
  }

  if (existing?.payload.origin === "mirrored" && op.kind === "delete") {
    return `This item belongs to ${existing.payload.source ?? "its source system"}; delete or close it there.`;
  }
  if (existing?.payload.origin === "mirrored" && op.kind === "create") {
    return "This connected item already exists; refresh it from its source instead of recreating it locally.";
  }
  if (existing?.payload.origin === "mirrored" && op.kind === "update") {
    const plannerOwnedFields = new Set(["priority", "estimateMinutes"]);
    const sourceOwnedFields = Object.keys(op.payload).filter((field) => !plannerOwnedFields.has(field));
    if (sourceOwnedFields.length > 0) {
      return `The connected source owns ${sourceOwnedFields.join(", ")}; no local change was applied.`;
    }
  }

  let next: PlannerItem;
  if (!existing) {
    next = incoming;
  } else if (existing.payload.origin === "mirrored") {
    // The normalized patch starts from the existing record, so a priority-only
    // update cannot replace the source title with an empty placeholder.
    next = refreshMirrored(existing.payload, incoming, incoming.fetchedAt ?? nowIso);
    if (op.payload.priority !== undefined) next.priority = incoming.priority;
    if (op.payload.estimateMinutes !== undefined) {
      next.estimateMinutes = incoming.estimateMinutes;
      next.estimateUpdatedAt = incoming.estimateUpdatedAt;
    }
  } else {
    next = mergeOwnedItem(existing.payload, incoming);
  }

  await persistPlannerItem(targetStore, orgId, userId, next);
  if (op.kind === "delete" && next.deletedAt) {
    await targetStore.tombstonePlannerBlocksForItem(orgId, userId, next.id, next.deletedAt);
  }
  return null;
}

async function persistPlannerItem(
  targetStore: PlannerMutationStore,
  orgId: string,
  userId: string,
  next: PlannerItem,
): Promise<void> {
  await targetStore.upsertPlannerItem(orgId, userId, {
    id: next.id,
    origin: next.origin,
    source: next.source ?? null,
    payload: next,
    dueDate: (next.dueDate?.value as string | null) ?? null,
    completed: next.completed?.value ?? false,
    deletedAtHlc: next.deletedAt
      ? `${next.deletedAt.physical}.${next.deletedAt.logical}.${next.deletedAt.deviceId}`
      : null,
  });
}

async function applyConflictResolution(
  targetStore: PlannerMutationStore,
  orgId: string,
  userId: string,
  op: ValidatedPlannerConflictResolutionOperation,
): Promise<string | null> {
  const existing = await targetStore.getPlannerItem(orgId, userId, op.itemId);
  if (!existing) return "The planner item does not exist.";
  if (existing.payload.origin !== "owned") {
    return "Connected-source items do not have locally resolvable text conflicts.";
  }
  const { field } = op.payload;
  if (field === "deleted") {
    const conflict = existing.payload.conflicts?.deleted;
    const watermark = existing.payload.deletionResolution;
    if (watermark && compareHlc(op.at, watermark.at) <= 0) return null;
    if (!conflict && !watermark) {
      return "The planner item has no unresolved deleted conflict.";
    }
    if (conflict
      && (compareHlc(op.at, conflict.oursAt) <= 0 || compareHlc(op.at, conflict.theirsAt) <= 0)) {
      return "The conflict resolution clock must be newer than both conflicting edits.";
    }
    const remaining = { ...(existing.payload.conflicts ?? {}) };
    delete remaining.deleted;
    const deleted = op.payload.keep === "ours";
    const next: PlannerItem = {
      ...existing.payload,
      ...(deleted ? { deletedAt: op.at } : { deletedAt: undefined }),
      deletionResolution: { deleted, at: op.at },
      ...(Object.keys(remaining).length > 0 ? { conflicts: remaining } : { conflicts: undefined }),
    };
    await persistPlannerItem(targetStore, orgId, userId, next);
    if (deleted) await targetStore.tombstonePlannerBlocksForItem(orgId, userId, next.id, op.at);
    return null;
  }
  const { value } = op.payload;
  const watermark = existing.payload.conflictResolutions?.[field];
  if (watermark && compareHlc(op.at, watermark) <= 0) return null;

  const conflict = existing.payload.conflicts?.[field];
  if (!conflict && !watermark) {
    return `The planner item has no unresolved ${field} conflict.`;
  }
  if (conflict
    && (compareHlc(op.at, conflict.oursAt) <= 0 || compareHlc(op.at, conflict.theirsAt) <= 0)) {
    return "The conflict resolution clock must be newer than both conflicting edits.";
  }

  const remaining = { ...(existing.payload.conflicts ?? {}) };
  delete remaining[field];
  const next: PlannerItem = {
    ...existing.payload,
    ...(field === "title"
      ? {
          title: causalValue(
            value,
            op.at,
            conflict ? { value: conflict.ours, at: conflict.oursAt, seen: [] } : existing.payload.title,
            conflict ? { value: conflict.theirs, at: conflict.theirsAt, seen: [] } : undefined,
          ),
        }
      : {
          notes: causalValue(
            value,
            op.at,
            conflict ? { value: conflict.ours, at: conflict.oursAt, seen: [] } : existing.payload.notes,
            conflict ? { value: conflict.theirs, at: conflict.theirsAt, seen: [] } : undefined,
          ),
        }),
    conflictResolutions: { ...existing.payload.conflictResolutions, [field]: op.at },
    ...(Object.keys(remaining).length > 0 ? { conflicts: remaining } : { conflicts: undefined }),
  };
  await persistPlannerItem(targetStore, orgId, userId, next);
  return null;
}

async function applyBlockOperation(
  targetStore: PlannerMutationStore,
  orgId: string,
  userId: string,
  op: ValidatedPlannerBlockOperation,
): Promise<string | null> {
  const existing = await targetStore.getPlannerBlock(orgId, userId, op.itemId);
  if (!existing && op.kind !== "create") return "The planner block does not exist.";

  const parentItemId = op.payload.itemId ?? existing?.itemId;
  const estimateMinutes = op.payload.estimateMinutes ?? existing?.estimateMinutes;
  if (!parentItemId) return "A created block needs a parent item id.";
  if (existing && op.payload.itemId !== undefined && op.payload.itemId !== existing.itemId) {
    return `A block cannot move from parent item ${existing.itemId} to ${op.payload.itemId}.`;
  }
  const parent = await targetStore.getPlannerItem(orgId, userId, parentItemId);
  if (!parent || parent.payload.deletedAt) {
    return `The parent planner item ${parentItemId} does not exist.`;
  }
  if (existing && compareHlc(op.at, existing.updatedAt) <= 0) return null;
  if (estimateMinutes === undefined || estimateMinutes <= 0) {
    return "A created block needs a positive estimate.";
  }

  await targetStore.upsertPlannerBlock(orgId, userId, {
    id: op.itemId,
    itemId: parentItemId,
    scheduledFor: op.payload.scheduledFor !== undefined
      ? op.payload.scheduledFor
      : existing?.scheduledFor ?? null,
    estimateMinutes,
    actualMinutes: op.payload.actualMinutes !== undefined
      ? op.payload.actualMinutes
      : existing?.actualMinutes ?? null,
    carriedOver: op.payload.carriedOver ?? existing?.carriedOver ?? 0,
    completedAt: op.payload.completedAt !== undefined
      ? op.payload.completedAt
      : existing?.completedAt ?? null,
    revision: existing?.revision ?? "0",
    updatedAt: op.at,
    deletedAt: null,
  });
  return null;
}

/**
 * Apply a client's operations, merging against server state.
 *
 * Three refusals, each returned rather than thrown, because the client keeps a
 * rejected operation in its outbox and shows it to a human — a thrown error
 * would collapse the whole batch and lose which operation was at fault.
 */
async function applyPushOperations(
  orgId: string,
  userId: string,
  operations: readonly unknown[],
  nowIso: string,
): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: [], rejected: [] };

  for (const raw of operations) {
    const validation = validatePlannerOperation(raw);
    if (!validation.ok) {
      outcome.rejected.push({
        idempotencyKey: validation.idempotencyKey,
        reason: validation.reason,
      });
      continue;
    }
    const op = validation.operation;
    const fingerprint = plannerOperationFingerprint(op);
    try {
      const refusal = await store().withPlannerMutation(orgId, userId, async (locked) => {
        // The receipt check and write share the mutation transaction. Two
        // concurrent redeliveries therefore cannot both apply before either
        // records the idempotency key.
        const receipt = await locked.getOperationReceipt(orgId, userId, op.idempotencyKey);
        if (receipt) {
          const sameLegacyTarget = receipt.fingerprint === null && receipt.itemId === op.itemId;
          const exact = receipt.fingerprint === fingerprint
            && receipt.itemId === op.itemId
            && receipt.entity === op.entity
            && receipt.operationKind === op.kind;
          return exact || sameLegacyTarget
            ? null
            : "This idempotency key was already used for a different Planner operation.";
        }
        const rejected = op.entity === "block"
          ? await applyBlockOperation(locked, orgId, userId, op)
          : await applyItemOperation(locked, orgId, userId, op, nowIso);
        if (rejected) return rejected;
        await locked.recordOperationApplied(
          orgId,
          userId,
          op.idempotencyKey,
          op.itemId,
          op.entity,
          op.kind,
          fingerprint,
        );
        return null;
      });
      if (refusal) {
        outcome.rejected.push({ idempotencyKey: op.idempotencyKey, reason: refusal });
        continue;
      }
      outcome.accepted.push(op.idempotencyKey);
    } catch (error) {
      outcome.rejected.push({
        idempotencyKey: op.idempotencyKey,
        reason: error instanceof Error ? error.message : "The server could not apply this change.",
      });
    }
  }
  return outcome;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function plannerOperationFingerprint(operation: ValidatedPlannerItemOperation | ValidatedPlannerBlockOperation): string {
  return createHash("sha256").update(canonicalJson({
    entity: operation.entity,
    kind: operation.kind,
    itemId: operation.itemId,
    at: operation.at,
    payload: operation.payload,
  })).digest("hex");
}

/** Apply operations already checked against the public TypeScript contract. */
export function pushOperations(
  orgId: string,
  userId: string,
  operations: readonly PushOperation[],
  nowIso: string,
): Promise<PushOutcome> {
  // Runtime validation still happens because typed values become untrusted as
  // soon as they cross JSON, IPC or a JavaScript caller.
  return applyPushOperations(orgId, userId, operations, nowIso);
}

/** HTTP ingress for values that have not crossed a TypeScript boundary. */
export function pushUntrustedOperations(
  orgId: string,
  userId: string,
  operations: readonly unknown[],
  nowIso: string,
): Promise<PushOutcome> {
  return applyPushOperations(orgId, userId, operations, nowIso);
}

/**
 * The server's own clock, sent with every pull so clients absorb it (D3).
 *
 * Derived from the database rather than the API process: ADR-027 D12 moved
 * lease expiry onto the database clock for exactly this reason, and a planner
 * whose authority runs on whichever API pod answered would reintroduce the skew
 * the HLC exists to survive.
 */
export function serverClock(nowMs: number): Hlc {
  return { physical: nowMs, logical: 0, deviceId: "server" };
}

/**
 * Which of two items is newer, for callers that need the answer without
 * performing a merge.
 */
export function isNewer(a: PlannerItem, b: PlannerItem): boolean {
  return compareHlc(a.title.at, b.title.at) > 0;
}

/**
 * Project issue records from a successfully-ingested, explicitly scoped
 * connector into the durable personal Planner store. This bypasses the client
 * outbox because it is a source re-read, and avoids an upsert when the mapped
 * payload is unchanged so repeated ingestion does not create revision churn.
 */
export async function refreshConnectedIssueDocuments(
  orgId: string,
  userId: string,
  input: {
    connectorId: string;
    source: ConnectorSource;
    sourceLabel: string;
    documents: readonly ConnectorDocumentRecord[];
  },
): Promise<PlannerProjectionSummary> {
  if (!orgId.trim() || !userId.trim()) {
    throw new Error("Connected Planner projection requires explicit organization and user scope.");
  }
  const projected = await createConnectorIssueSourceAdapter(input).list();
  const summary: PlannerProjectionSummary = {
    created: 0, updated: 0, unchanged: 0,
    skipped: input.documents.length - projected.length,
  };

  for (const remote of projected) {
    const result = await store().withPlannerMutation(orgId, userId, async (locked) => {
      const existing = await locked.getPlannerItem(orgId, userId, remote.id);
      if (existing && (existing.payload.origin !== "mirrored" || existing.payload.source !== remote.source)) {
        return "skipped" as const;
      }
      const next = existing
        ? refreshMirrored(existing.payload, remote, remote.fetchedAt!)
        : remote;
      if (existing && isDeepStrictEqual(existing.payload, next)) return "unchanged" as const;
      await persistPlannerItem(locked, orgId, userId, next);
      return existing ? "updated" as const : "created" as const;
    });
    summary[result] += 1;
  }
  return summary;
}

/**
 * One item, by id — ADR-029 C1's `resolve` for `brainrouter://planner/item/…`.
 *
 * Q5 makes resolution a server capability, because the dashboard has no local
 * store to look in. This is the read that answers it; before it existed the only
 * way to see one item from the server was to pull the whole list.
 */
export async function getItem(orgId: string, userId: string, id: string): Promise<PlannerItem | null> {
  const row = await store().getPlannerItem(orgId, userId, id);
  return row ? row.payload : null;
}

/**
 * Make a task — ADR-029 C1's `create` for the planner.
 *
 * Q2: the cross-mode create calls the OWNING mode's writer rather than reaching
 * into its tables, so "a chat turn becomes a task" lands here and ownership is
 * preserved by construction. It is synchronous and returns the item, because the
 * caller has to write the resulting reference into its own content — an async
 * create that fails afterwards leaves a note claiming a task that does not exist.
 */
export async function createItem(
  orgId: string,
  userId: string,
  input: { title: string; notes?: string; dueDate?: string | null },
  nowMs: number,
): Promise<PlannerItem> {
  const title = input.title.trim();
  if (!title) throw new Error("A created item needs a title.");

  const at = serverClock(nowMs);
  const item: PlannerItem = {
    id: `itm_${randomUUID().slice(0, 8)}`,
    origin: "owned",
    title: causalValue(title, at),
    ...(input.notes ? { notes: causalValue(input.notes, at) } : {}),
    ...(input.dueDate !== undefined ? { dueDate: { value: input.dueDate, at } } : {}),
  };
  await store().withPlannerMutation(orgId, userId, (locked) =>
    persistPlannerItem(locked, orgId, userId, item));
  return item;
}

export async function listBlocks(orgId: string, userId: string): Promise<PlannerBlockRow[]> {
  return store().listPlannerBlocks(orgId, userId);
}

export async function upsertBlock(
  orgId: string,
  userId: string,
  block: PlannerBlockRow,
): Promise<PlannerBlockRow> {
  return store().withPlannerMutation(orgId, userId, async (locked) => {
    const parent = await locked.getPlannerItem(orgId, userId, block.itemId);
    if (!parent || parent.payload.deletedAt) {
      throw new Error(`The parent planner item ${block.itemId} does not exist.`);
    }
    const existing = await locked.getPlannerBlock(orgId, userId, block.id);
    if (existing?.itemId !== undefined && existing.itemId !== block.itemId) {
      throw new Error(`A block cannot move from parent item ${existing.itemId} to ${block.itemId}.`);
    }
    if (existing && compareHlc(block.updatedAt, existing.updatedAt) <= 0) return existing;
    return locked.upsertPlannerBlock(orgId, userId, block);
  });
}
