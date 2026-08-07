/**
 * Planner backend — the data plane behind `/api/planner` (migration 051).
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
 * about who won.
 */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import {
  mergeOwnedItem, refreshMirrored, compareHlc,
  type PlannerItem, type Hlc,
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
}

export interface PushOperation {
  idempotencyKey: string;
  itemId: string;
  kind: "create" | "update" | "delete" | "source_action";
  at: Hlc;
  payload: unknown;
}

export interface PushOutcome {
  accepted: string[];
  rejected: Array<{ idempotencyKey: string; reason: string }>;
}

interface PlannerStore {
  listPlannerItemsSince(orgId: string, userId: string, since?: string): Promise<PlannerRow[]>;
  getPlannerItem(orgId: string, userId: string, id: string): Promise<PlannerRow | null>;
  /**
   * Takes a ROW, not a PlannerItem.
   *
   * The interface said `PlannerItem` and the query has always taken a row —
   * which is why the merged item landed with a null `payload_json`. The types
   * agreed with each other all the way down and disagreed with the database.
   */
  upsertPlannerItem(orgId: string, userId: string, row: {
    id: string;
    origin: string;
    source: string | null;
    payload: PlannerItem;
    dueDate: string | null;
    completed: boolean;
    deletedAtHlc: string | null;
  }): Promise<PlannerRow>;
  listPlannerBlocks(orgId: string, userId: string): Promise<PlannerBlockRow[]>;
  upsertPlannerBlock(orgId: string, userId: string, block: PlannerBlockRow): Promise<PlannerBlockRow>;
  wasOperationApplied(orgId: string, userId: string, key: string): Promise<boolean>;
  recordOperationApplied(orgId: string, userId: string, key: string, itemId: string): Promise<void>;
  latestPlannerRevision(orgId: string, userId: string): Promise<string>;
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
): Promise<{ items: PlannerItem[]; cursor: string }> {
  const rows = await store().listPlannerItemsSince(orgId, userId, since);
  return {
    items: rows.map((r) => r.payload),
    cursor: await store().latestPlannerRevision(orgId, userId),
  };
}

/**
 * Apply a client's operations, merging against server state.
 *
 * Three refusals, each returned rather than thrown, because the client keeps a
 * rejected operation in its outbox and shows it to a human — a thrown error
 * would collapse the whole batch and lose which operation was at fault.
 */
export async function pushOperations(
  orgId: string,
  userId: string,
  operations: readonly PushOperation[],
  nowIso: string,
): Promise<PushOutcome> {
  const outcome: PushOutcome = { accepted: [], rejected: [] };

  for (const op of operations) {
    // Idempotency first: a redelivered push must be a no-op, not a second
    // apply. Reported as accepted because from the client's side it DID land.
    if (await store().wasOperationApplied(orgId, userId, op.idempotencyKey)) {
      outcome.accepted.push(op.idempotencyKey);
      continue;
    }

    // The payload is a PATCH, not a whole item: the client sends the fields it
    // changed and the operation carries the id and the stamp. Treating it as a
    // complete PlannerItem meant every insert arrived with a null `id` — caught
    // only by running a real push against a real database, because the type
    // assertion made it look correct all the way down.
    const patch = op.payload as Record<string, unknown> | undefined;
    if (!patch || typeof patch !== "object") {
      outcome.rejected.push({
        idempotencyKey: op.idempotencyKey,
        reason: "The operation carried no usable item.",
      });
      continue;
    }
    const stamped = <T>(value: T) => ({ value, at: op.at });
    const incoming: PlannerItem = {
      id: op.itemId,
      origin: "owned",
      title: stamped(typeof patch.title === "string" ? patch.title : ""),
      ...(typeof patch.notes === "string" ? { notes: stamped(patch.notes) } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: stamped(patch.dueDate as string | null) } : {}),
      ...(typeof patch.priority === "number" ? { priority: stamped(patch.priority) } : {}),
      ...(typeof patch.completed === "boolean" ? { completed: stamped(patch.completed) } : {}),
      // A delete is a tombstone stamped with the operation's clock (D4), so a
      // later edit from another device can resurrect it as conflicted.
      ...(op.kind === "delete" ? { deletedAt: op.at } : {}),
    };
    if (!incoming.title.value && op.kind === "create") {
      outcome.rejected.push({
        idempotencyKey: op.idempotencyKey,
        reason: "A created item needs a title.",
      });
      continue;
    }

    try {
      const existing = await store().getPlannerItem(orgId, userId, op.itemId);

      let next: PlannerItem;
      if (!existing) {
        next = incoming;
      } else if (existing.payload.origin === "mirrored") {
        // D1: the source owns the truth. A client cannot overwrite a mirrored
        // item's own fields — only its planner metadata, which refreshMirrored
        // preserves.
        next = refreshMirrored(existing.payload, incoming, nowIso);
      } else {
        // D11: merged against the server's current state, so a stale client
        // cannot win by arriving last.
        next = mergeOwnedItem(existing.payload, incoming);
      }

      // The query layer takes a ROW, not a PlannerItem: the merged item travels
      // in `payload` and the indexed columns are projected out of it. Passing
      // the item straight through left `payload_json` null — the second half of
      // the same mistake as the id, and equally invisible to the type system
      // because the adapter's parameter type is inferred from the query.
      await store().upsertPlannerItem(orgId, userId, {
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
      await store().recordOperationApplied(orgId, userId, op.idempotencyKey, op.itemId);
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
    title: { value: title, at },
    ...(input.notes ? { notes: { value: input.notes, at } } : {}),
    ...(input.dueDate !== undefined ? { dueDate: { value: input.dueDate, at } } : {}),
  };
  await store().upsertPlannerItem(orgId, userId, {
    id: item.id,
    origin: item.origin,
    source: null,
    payload: item,
    dueDate: (item.dueDate?.value as string | null) ?? null,
    completed: false,
    deletedAtHlc: null,
  });
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
  return store().upsertPlannerBlock(orgId, userId, block);
}
