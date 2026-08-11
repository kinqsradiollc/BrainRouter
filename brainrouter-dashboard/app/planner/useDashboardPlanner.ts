/**
 * ADR-038 — Dashboard host adapter for the shared Planner presentation.
 *
 * Auth, stamped wire operations and the browser's durable outbox stay here;
 * hierarchy, keyboard behavior and visuals stay in `@kinqs/brainrouter-ui`.
 * The outbox is scoped by authenticated subject so one browser account never
 * sees another account's queued planner text.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlannerBlockPushOperation,
  PlannerConflictResolutionOperation,
  PlannerItemPushOperation,
  PlannerPushOutcome,
  PlannerWireHlc,
} from "@kinqs/brainrouter-types/planner";
import type {
  PlannerBlockView,
  PlannerItemView,
  PlannerOps,
  PlannerSyncView,
} from "@kinqs/brainrouter-ui/planner";

import { authFetch } from "../../lib/adminApi";
import { getJwt } from "../../lib/client-auth";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import {
  type ApiPlannerBlock,
  type ApiPlannerItem,
  type DashboardPlannerOperation,
  isPlannerWireHlc,
  invalidPlannerPushOutcome,
  latestPlannerEnvelopeClock,
  latestPlannerWireHlc,
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

interface PlannerEnvelope {
  items?: ApiPlannerItem[];
  blocks?: ApiPlannerBlock[];
  cursor?: string;
  serverClock?: PlannerWireHlc;
}

interface DashboardPlannerState {
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  sync: PlannerSyncView;
  staleSources: string[];
  ops: PlannerOps;
  loading: boolean;
  error: string | null;
}

const ACTIVE_REFRESH_MS = 5_000;
const STALE_SOURCE_MS = 15 * 60_000;
const ATTEMPTS_BEFORE_SURFACING = 5;
const PUSH_BATCH_LIMIT = 200;
const PULL_PAGE_LIMIT = 1_000;
const MAX_PULL_PAGES = 100;
let clock: PlannerWireHlc = { physical: 0, logical: 0, deviceId: "" };
let fallbackReplicaId = "";

function replicaId(): string {
  const key = "br-planner-tab-replica";
  if (!fallbackReplicaId) fallbackReplicaId = `web-${crypto.randomUUID()}`;
  try {
    let value = window.sessionStorage.getItem(key);
    if (!value) {
      value = fallbackReplicaId;
      window.sessionStorage.setItem(key, value);
    }
    return value;
  } catch {
    return fallbackReplicaId;
  }
}

function clockStorageKey(): string {
  return `br-planner-clock:${replicaId()}`;
}

function persistedClock(): PlannerWireHlc | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(clockStorageKey()) ?? "null") as unknown;
    return isPlannerWireHlc(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function observeClock(observed: PlannerWireHlc): void {
  const current = persistedClock();
  clock = latestPlannerWireHlc([clock, observed, ...(current ? [current] : [])]);
  try { window.sessionStorage.setItem(clockStorageKey(), JSON.stringify(clock)); } catch { /* in-memory still advances */ }
}

function nextStamp(): PlannerWireHlc {
  const restored = persistedClock();
  clock = tickPlannerWireHlc([clock, ...(restored ? [restored] : [])], Date.now(), replicaId());
  try { window.sessionStorage.setItem(clockStorageKey(), JSON.stringify(clock)); } catch { /* outbox is authoritative */ }
  return clock;
}

function authSubject(): string {
  const token = getJwt();
  if (!token) return "local";
  const encoded = token.split(".")[1];
  if (!encoded) return "local";
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) : "local";
  } catch {
    return "local";
  }
}

function operationKey(): string {
  return crypto.randomUUID();
}

function ageLabel(ageMs: number): string {
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function sourceAge(fetchedAt: string): string {
  const age = Date.now() - Date.parse(fetchedAt);
  return age <= STALE_SOURCE_MS ? "Current" : `Refreshed ${ageLabel(age)} ago`;
}

export function useDashboardPlanner(): DashboardPlannerState {
  const { activeOrgId, loading: orgLoading, error: orgError } = useActiveOrg();
  const scopeReady = !orgLoading && !orgError && activeOrgId.length > 0;
  const storageKey = plannerOutboxStorageKey(activeOrgId || "unbound", authSubject());
  const [rawItems, setRawItems] = useState<ApiPlannerItem[]>([]);
  const [rawBlocks, setRawBlocks] = useState<ApiPlannerBlock[]>([]);
  const [outbox, setOutbox] = useState<DashboardPlannerOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>();
  const outboxRef = useRef<DashboardPlannerOperation[]>([]);
  const storageKeyRef = useRef(storageKey);
  const loadSequenceRef = useRef(0);
  const cycleRef = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const cycleAgainRef = useRef(false);
  const explicitRetryRef = useRef(new Set<string>());
  storageKeyRef.current = storageKey;

  const publishOutbox = useCallback((next: DashboardPlannerOperation[]): void => {
    if (storageKeyRef.current !== storageKey) return;
    outboxRef.current = next;
    setOutbox(next);
  }, [storageKey]);

  const refreshOutbox = useCallback((): DashboardPlannerOperation[] => {
    const next = readPlannerOutbox(window.localStorage, storageKey);
    publishOutbox(next);
    return next;
  }, [publishOutbox, storageKey]);

  const pullSnapshot = useCallback(async (): Promise<void> => {
    if (!scopeReady || !activeOrgId) throw new Error(orgError || "Choose an active organization first.");
    const requestedScope = storageKey;
    const sequence = ++loadSequenceRef.current;
    let cursor: string | undefined;
    const itemById = new Map<string, ApiPlannerItem>();
    const blockById = new Map<string, ApiPlannerBlock>();
    let observedClock: PlannerWireHlc | null = null;

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const path = cursor
        ? `/api/planner/pull?since=${encodeURIComponent(cursor)}`
        : "/api/planner/pull";
      const body = await authFetch<PlannerEnvelope>(path, {
        orgId: activeOrgId,
      });
      if (storageKeyRef.current !== requestedScope || sequence !== loadSequenceRef.current) return;
      if (body.items !== undefined && !Array.isArray(body.items)) throw new Error("Planner pull returned invalid items.");
      if (body.blocks !== undefined && !Array.isArray(body.blocks)) throw new Error("Planner pull returned invalid blocks.");
      const pageItems = body.items ?? [];
      const pageBlocks = body.blocks ?? [];
      for (const item of pageItems) itemById.set(item.id, item);
      for (const block of pageBlocks) blockById.set(block.id, block);
      const pageClock = latestPlannerEnvelopeClock(pageItems, pageBlocks, body.serverClock);
      if (pageClock) observedClock = observedClock
        ? latestPlannerWireHlc([observedClock, pageClock])
        : pageClock;

      const needsNextPage = pageItems.length >= PULL_PAGE_LIMIT || pageBlocks.length >= PULL_PAGE_LIMIT;
      if (!needsNextPage) break;
      if (!body.cursor || body.cursor === cursor) {
        throw new Error("Planner pull pagination did not advance its cursor.");
      }
      cursor = body.cursor;
      if (page === MAX_PULL_PAGES - 1) {
        throw new Error("Planner pull exceeded the bounded full-snapshot page limit.");
      }
    }

    const durable = refreshOutbox();
    const projection = replayPlannerOutbox([...itemById.values()], [...blockById.values()], durable);
    if (storageKeyRef.current !== requestedScope || sequence !== loadSequenceRef.current) return;
    setRawItems(projection.items);
    setRawBlocks(projection.blocks);
    if (observedClock) observeClock(observedClock);
    setLoading(false);
  }, [activeOrgId, orgError, refreshOutbox, scopeReady, storageKey]);

  const pushPending = useCallback(async (only?: ReadonlySet<string>): Promise<boolean> => {
    if (!scopeReady || !activeOrgId) return false;
    const requestedScope = storageKey;
    const pending = selectPlannerOperationsForDrain(
      refreshOutbox(),
      ATTEMPTS_BEFORE_SURFACING,
      only,
    );
    if (pending.length === 0) return false;
    setRetrying(true);
    try {
      for (const batch of plannerPushBatches(pending, PUSH_BATCH_LIMIT)) {
        let outcome: PlannerPushOutcome;
        try {
          outcome = await authFetch<PlannerPushOutcome>("/api/planner/push", {
            method: "POST",
            body: { operations: batch },
            orgId: activeOrgId,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "The server could not apply this change.";
          persistPlannerOperations(window.localStorage, storageKey, batch.map((operation) => ({
            ...operation,
            attempts: (operation.attempts ?? 0) + 1,
            lastError: message,
          })));
          refreshOutbox();
          throw cause;
        }
        if (storageKeyRef.current !== requestedScope) return false;
        const invalid = invalidPlannerPushOutcome(batch, outcome);
        if (invalid) {
          persistPlannerOperations(window.localStorage, storageKey, batch.map((operation) => ({
            ...operation,
            attempts: (operation.attempts ?? 0) + 1,
            lastError: invalid,
          })));
          refreshOutbox();
          throw new Error(invalid);
        }
        const accepted = new Set(outcome.accepted);
        const rejected = new Map(outcome.rejected.map((entry) => [entry.idempotencyKey, entry.reason]));
        const failed = batch.flatMap((operation) => {
          const reason = rejected.get(operation.idempotencyKey);
          return reason ? [{
            ...operation,
            attempts: (operation.attempts ?? 0) + 1,
            lastError: reason,
          }] : [];
        });
        if (failed.length > 0) persistPlannerOperations(window.localStorage, storageKey, failed);
        if (accepted.size > 0) removePlannerOperations(window.localStorage, storageKey, accepted);
        refreshOutbox();
      }
      setLastSyncedAt(new Date().toISOString());
      return true;
    } finally {
      if (storageKeyRef.current === requestedScope) setRetrying(false);
    }
  }, [activeOrgId, refreshOutbox, scopeReady, storageKey]);

  const reconcile = useCallback((only?: ReadonlySet<string>): Promise<void> => {
    if (!scopeReady || !activeOrgId) {
      setLoading(orgLoading);
      setError(orgError || (orgLoading ? null : "No active organization is available."));
      return Promise.resolve();
    }
    if (only) for (const id of only) explicitRetryRef.current.add(id);
    const existing = cycleRef.current;
    if (existing?.scope === storageKey) {
      cycleAgainRef.current = true;
      return existing.promise;
    }
    const requestedScope = storageKey;
    const run = (async () => {
      do {
        cycleAgainRef.current = false;
        const explicit = explicitRetryRef.current.size > 0
          ? new Set(explicitRetryRef.current)
          : undefined;
        explicitRetryRef.current.clear();
        try {
          // A successful pull is the precondition for every push.
          await pullSnapshot();
          if (storageKeyRef.current !== requestedScope) return;
          const pushed = await pushPending(explicit);
          if (pushed && storageKeyRef.current === requestedScope) await pullSnapshot();
          if (storageKeyRef.current === requestedScope) setError(null);
        } catch (cause) {
          if (storageKeyRef.current !== requestedScope) return;
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Could not reconcile the planner.");
        }
      } while (cycleAgainRef.current && storageKeyRef.current === requestedScope);
    })();
    cycleRef.current = { scope: requestedScope, promise: run };
    void run.finally(() => {
      if (cycleRef.current?.promise === run) cycleRef.current = null;
    });
    return run;
  }, [activeOrgId, orgError, orgLoading, pullSnapshot, pushPending, scopeReady, storageKey]);

  const enqueueMany = useCallback((operations: readonly DashboardPlannerOperation[]): boolean => {
    if (!scopeReady || !activeOrgId) {
      setError(orgError || "Choose an active organization before editing Planner data.");
      return false;
    }
    try {
      const next = persistPlannerOperations(window.localStorage, storageKey, operations);
      publishOutbox(next);
      for (const operation of operations) observeClock(operation.at);
      cycleAgainRef.current = true;
      window.setTimeout(() => { void reconcile(); }, 0);
      return true;
    } catch (cause) {
      setError(cause instanceof Error
        ? `This Planner change was not made because it could not be saved: ${cause.message}`
        : "This Planner change was not made because browser storage is unavailable.");
      return false;
    }
  }, [activeOrgId, orgError, publishOutbox, reconcile, scopeReady, storageKey]);

  const enqueue = useCallback((operation: DashboardPlannerOperation): boolean =>
    enqueueMany([operation]), [enqueueMany]);

  useEffect(() => {
    loadSequenceRef.current += 1;
    setRawItems([]);
    setRawBlocks([]);
    setLoading(orgLoading || scopeReady);
    setError(orgError || (!orgLoading && !activeOrgId ? "No active organization is available." : null));
    setRetrying(false);
    setLastSyncedAt(undefined);
    if (!scopeReady) {
      outboxRef.current = [];
      setOutbox([]);
      return;
    }
    try {
      const stored = migratePlannerOutbox(window.localStorage, storageKey);
      publishOutbox(stored);
      const latestQueued = latestPlannerWireHlc(stored.map((operation) => operation.at));
      if (stored.length > 0) observeClock(latestQueued);
      void reconcile();
    } catch (cause) {
      setLoading(false);
      setError(cause instanceof Error
        ? `Planner storage is unavailable: ${cause.message}`
        : "Planner storage is unavailable.");
    }
  }, [activeOrgId, orgError, orgLoading, publishOutbox, reconcile, scopeReady, storageKey]);

  useEffect(() => {
    const tick = (): void => {
      if (document.hidden) return;
      void reconcile();
    };
    const timer = window.setInterval(tick, ACTIVE_REFRESH_MS);
    window.addEventListener("focus", tick);
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== storageKey && !event.key?.startsWith(`${storageKey}:operation:`)) return;
      try {
        refreshOutbox();
        void reconcile();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Planner storage is unavailable.");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      window.removeEventListener("storage", onStorage);
    };
  }, [reconcile, refreshOutbox, storageKey]);

  const items = useMemo<PlannerItemView[]>(() => rawItems.map((item) => {
    const provenance = item.provenance;
    const fetchedAt = provenance?.fetchedAt ?? item.fetchedAt;
    return {
      id: item.id,
      title: item.title.value,
      notes: item.notes?.value,
      dueDate: item.dueDate?.value ?? undefined,
      priority: item.priority?.value,
      completed: item.completed?.value === true,
      origin: item.origin,
      source: item.source,
      ...(provenance
        ? {
            provenance: {
              source: provenance.sourceLabel,
              kind: provenance.sourceId,
              externalId: provenance.externalId,
              url: provenance.sourceUrl,
              fetchedAt: provenance.fetchedAt,
            },
          }
        : {}),
      estimateMinutes: item.estimateMinutes,
      blockedReason: item.blockedReason?.value ?? undefined,
      capabilities: {
        editTitle: item.origin === "owned",
        complete: item.origin === "owned",
        delete: item.origin === "owned",
      },
      ...(fetchedAt
        ? {
            sourceFreshness: {
              label: sourceAge(fetchedAt),
              fetchedAt,
              stale: Date.now() - Date.parse(fetchedAt) > STALE_SOURCE_MS,
            },
          }
        : {}),
      conflictFields: Object.keys(item.conflicts ?? {}),
      conflicts: Object.entries(item.conflicts ?? {}).flatMap(([field, raw]) => {
        if (!raw || typeof raw !== "object") return [];
        const record = raw as Record<string, unknown>;
        return [{
          field,
          versionA: { label: "Version A", value: String(record.ours ?? "") },
          versionB: { label: "Version B", value: String(record.theirs ?? "") },
        }];
      }),
    };
  }), [rawItems]);

  const blocks = useMemo<PlannerBlockView[]>(() => rawBlocks.map((block) => ({
    id: block.id,
    itemId: block.itemId,
    ...(block.scheduledFor ? { scheduledFor: block.scheduledFor } : {}),
    estimateMinutes: block.estimateMinutes,
    ...(typeof block.actualMinutes === "number" ? { actualMinutes: block.actualMinutes } : {}),
    carriedOver: block.carriedOver,
    ...(block.completedAt ? { completedAt: block.completedAt } : {}),
  })), [rawBlocks]);

  const itemTitle = useMemo(() => new Map(items.map((item) => [item.id, item.title])), [items]);
  const blockItem = useMemo(() => new Map(blocks.map((block) => [block.id, block.itemId])), [blocks]);
  const sync = useMemo<PlannerSyncView>(() => ({
    label: outbox.length === 0
      ? "Everything is synced."
      : `${outbox.length} change${outbox.length === 1 ? "" : "s"} waiting to sync.`,
    pendingCount: outbox.length,
    retrying,
    lastSyncedAt,
    issues: outbox.map((operation) => {
      const entity = operation.entity ?? "item";
      const parentItemId = entity === "block" ? blockItem.get(operation.itemId) : operation.itemId;
      return {
        id: operation.idempotencyKey,
        entity,
        itemId: parentItemId ?? operation.itemId,
        itemTitle: parentItemId ? itemTitle.get(parentItemId) : undefined,
        action: operation.kind,
        createdAt: new Date(operation.at.physical).toISOString(),
        ageLabel: ageLabel(Date.now() - operation.at.physical),
        attempts: operation.attempts ?? 0,
        lastError: operation.lastError,
        stuck: (operation.attempts ?? 0) >= ATTEMPTS_BEFORE_SURFACING,
      };
    }),
    onRetry: () => {
      void reconcile(new Set(outboxRef.current.map((operation) => operation.idempotencyKey)));
    },
    onRetryIssue: (id) => { void reconcile(new Set([id])); },
  }), [blockItem, itemTitle, lastSyncedAt, outbox, reconcile, retrying]);

  const addItem = useCallback((title: string): void => {
    const at = nextStamp();
    const id = `itm_web_${crypto.randomUUID()}`;
    const operation: PlannerItemPushOperation = {
      idempotencyKey: operationKey(),
      itemId: id,
      entity: "item",
      kind: "create",
      at,
      payload: { title: { value: title, at, seen: [] } },
    };
    if (!enqueue(operation)) return;
    setRawItems((current) => [{ id, origin: "owned", title: { value: title, at, seen: [] } }, ...current]);
  }, [enqueue]);

  const updateItem = useCallback((id: string, completed: boolean): void => {
    const at = nextStamp();
    if (!rawItems.some((candidate) => candidate.id === id)) return;
    const operation: PlannerItemPushOperation = {
      idempotencyKey: operationKey(),
      itemId: id,
      entity: "item",
      kind: "update",
      at,
      payload: { completed },
    };
    if (!enqueue(operation)) return;
    setRawItems((current) => current.map((candidate) => candidate.id === id
      ? { ...candidate, completed: { value: completed, at } }
      : candidate));
  }, [enqueue, rawItems]);

  const deleteItem = useCallback((id: string): void => {
    const at = nextStamp();
    if (!rawItems.some((candidate) => candidate.id === id)) return;
    const operation: PlannerItemPushOperation = {
      idempotencyKey: operationKey(),
      itemId: id,
      entity: "item",
      kind: "delete",
      at,
      payload: {},
    };
    if (!enqueue(operation)) return;
    setRawItems((current) => current.filter((candidate) => candidate.id !== id));
    setRawBlocks((current) => current.filter((block) => block.itemId !== id));
  }, [enqueue, rawItems]);

  const blockTimeAt = useCallback((scheduledFor: string): void => {
    const itemAt = nextStamp();
    const itemId = `itm_web_${crypto.randomUUID()}`;
    const blockAt = nextStamp();
    const blockId = `blk_web_${crypto.randomUUID()}`;
    const itemOperation = {
      idempotencyKey: operationKey(),
      itemId,
      entity: "item",
      kind: "create",
      at: itemAt,
      payload: { title: { value: "Focus block", at: itemAt, seen: [] } },
    } satisfies PlannerItemPushOperation;
    const blockOperation = {
      idempotencyKey: operationKey(),
      itemId: blockId,
      entity: "block",
      kind: "create",
      at: blockAt,
      payload: { id: blockId, itemId, scheduledFor, estimateMinutes: 60, carriedOver: 0 },
    } satisfies PlannerBlockPushOperation;
    if (!enqueueMany([itemOperation, blockOperation])) return;
    setRawItems((current) => [{
      id: itemId, origin: "owned", title: { value: "Focus block", at: itemAt, seen: [] },
    }, ...current]);
    setRawBlocks((current) => [...current, { id: blockId, itemId, scheduledFor, estimateMinutes: 60, carriedOver: 0 }]);
  }, [enqueueMany]);

  const rescheduleBlock = useCallback((blockId: string, scheduledFor: string): void => {
    const block = rawBlocks.find((candidate) => candidate.id === blockId);
    if (!block) return;
    const at = nextStamp();
    const operation = {
      idempotencyKey: operationKey(),
      itemId: blockId,
      entity: "block",
      kind: "update",
      at,
      payload: { itemId: block.itemId, scheduledFor },
    } satisfies PlannerBlockPushOperation;
    if (!enqueue(operation)) return;
    setRawBlocks((current) => current.map((candidate) => candidate.id === blockId
      ? { ...candidate, scheduledFor }
      : candidate));
  }, [enqueue, rawBlocks]);

  const recordActual = useCallback((blockId: string, actualMinutes: number): void => {
    const block = rawBlocks.find((candidate) => candidate.id === blockId);
    if (!block || !Number.isFinite(actualMinutes) || actualMinutes < 0) return;
    const at = nextStamp();
    const completedAt = new Date().toISOString();
    const operation = {
      idempotencyKey: operationKey(),
      itemId: blockId,
      entity: "block",
      kind: "update",
      at,
      payload: { itemId: block.itemId, actualMinutes, completedAt },
    } satisfies PlannerBlockPushOperation;
    if (!enqueue(operation)) return;
    setRawBlocks((current) => current.map((candidate) => candidate.id === blockId
      ? { ...candidate, actualMinutes, completedAt, updatedAt: at }
      : candidate));
  }, [enqueue, rawBlocks]);

  const resolveConflict = useCallback((id: string, field: string, keep: "ours" | "theirs"): void => {
    if (field !== "title" && field !== "notes" && field !== "deleted") return;
    const item = rawItems.find((candidate) => candidate.id === id);
    const conflict = item?.conflicts?.[field];
    if (!conflict || typeof conflict !== "object") return;
    const conflictRecord = conflict as Record<string, unknown>;
    const chosen = conflictRecord[keep];
    if (field !== "deleted" && typeof chosen !== "string") return;
    // A resolution must be causally newer than both edits it acknowledges,
    // including a remote device whose clock is ahead of this browser's wall.
    if (isPlannerWireHlc(conflictRecord.oursAt)) observeClock(conflictRecord.oursAt);
    if (isPlannerWireHlc(conflictRecord.theirsAt)) observeClock(conflictRecord.theirsAt);
    const at = nextStamp();
    const operation = {
      idempotencyKey: operationKey(),
      itemId: id,
      entity: "item",
      kind: "resolve_conflict",
      at,
      payload: field === "deleted" ? { field, keep } : { field, value: String(chosen) },
    } satisfies PlannerConflictResolutionOperation;
    if (!enqueue(operation)) return;
    setRawItems((current) => current.map((candidate) => {
      if (candidate.id !== id) return candidate;
      const conflicts = { ...(candidate.conflicts ?? {}) };
      delete conflicts[field];
      if (field === "deleted") {
        const deleted = keep === "ours";
        return {
          ...candidate,
          ...(deleted ? { deletedAt: at } : { deletedAt: undefined }),
          deletionResolution: { deleted, at },
          ...(Object.keys(conflicts).length > 0 ? { conflicts } : { conflicts: undefined }),
        };
      }
      return {
        ...candidate,
        ...(field === "title"
          ? { title: {
              value: String(chosen), at,
              seen: [conflictRecord.oursAt, conflictRecord.theirsAt].filter(isPlannerWireHlc),
            } }
          : { notes: {
              value: String(chosen), at,
              seen: [conflictRecord.oursAt, conflictRecord.theirsAt].filter(isPlannerWireHlc),
            } }),
        ...(Object.keys(conflicts).length > 0 ? { conflicts } : { conflicts: undefined }),
      };
    }));
    if (field === "deleted" && keep === "ours") {
      setRawItems((current) => current.filter((candidate) => candidate.id !== id));
      setRawBlocks((current) => current.filter((block) => block.itemId !== id));
    }
  }, [enqueue, rawItems]);

  const ops = useMemo<PlannerOps>(() => ({
    addItem,
    toggleComplete: updateItem,
    deleteItem,
    resolveConflict,
    blockTimeAt,
    rescheduleBlock,
    recordActual,
    openSource: (url) => {
      if (!/^https:\/\//i.test(url)) return;
      window.open(url, "_blank", "noopener,noreferrer");
    },
  }), [addItem, blockTimeAt, deleteItem, recordActual, rescheduleBlock, resolveConflict, updateItem]);

  const staleSources = useMemo(() => [...new Set(items.flatMap((item) =>
    item.sourceFreshness?.stale && item.sourceFreshness.label
      ? [`${item.provenance?.source ?? item.source ?? "Source"}: ${item.sourceFreshness.label}.`]
      : []))], [items]);

  return { items, blocks, sync, staleSources, ops, loading, error };
}
