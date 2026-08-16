/**
 * ADR-038 D3/D4 — browser-safe planner sync contracts.
 *
 * These shapes cross the Core, Electron and HTTP boundaries, so they live in
 * the dependency-free types package. Runtime validation remains in Core: this
 * module deliberately contains no I/O and no implementation imports.
 */

export interface PlannerWireHlc {
  physical: number;
  logical: number;
  deviceId: string;
}

export interface PlannerWireStamped<T> {
  value: T;
  at: PlannerWireHlc;
  /** Newest observed event per replica; absent only on legacy records. */
  seen?: PlannerWireHlc[];
}

/** Structured, actionable identity for a mirrored planner item. */
export interface PlannerProvenance {
  /** Stable adapter/connector id, for example `github`. */
  sourceId: string;
  /** Human-readable source name shown beside the item. */
  sourceLabel: string;
  /** The source record's stable id, when it has one. */
  externalId?: string;
  /** An HTTPS URL that opens the source record in its owning system. */
  sourceUrl?: string;
  /** When the source was last read successfully. */
  fetchedAt: string;
}

export type PlannerOperationEntity = 'item' | 'block';
export type PlannerItemMutationKind = 'create' | 'update' | 'delete' | 'source_action';
export type PlannerItemOperationKind = PlannerItemMutationKind | 'resolve_conflict';
export type PlannerBlockOperationKind = 'create' | 'update';

/**
 * Item payloads accept primitive patches and the stamped values older clients
 * sent. The server normalizes both forms before applying the operation.
 */
export interface PlannerItemWirePayload {
  id?: string;
  origin?: 'owned' | 'mirrored';
  source?: string;
  fetchedAt?: string;
  externalId?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  provenance?: PlannerProvenance;
  title?: string | PlannerWireStamped<string>;
  notes?: string | PlannerWireStamped<string>;
  dueDate?: string | null | PlannerWireStamped<string | null>;
  priority?: number | PlannerWireStamped<number>;
  completed?: boolean | PlannerWireStamped<boolean>;
  estimateMinutes?: number | PlannerWireStamped<number>;
  blockedReason?: string | null | PlannerWireStamped<string | null>;
}

/** Fields whose competing versions require an explicit human choice. */
export type PlannerConflictField = 'title' | 'notes' | 'deleted';

/** A conflict resolution is a deliberate choice, not a general item patch. */
export type PlannerConflictResolutionWirePayload =
  | { field: 'title' | 'notes'; value: string }
  | { field: 'deleted'; keep: 'ours' | 'theirs' };

export interface PlannerBlockWirePayload {
  id?: string;
  /** Parent planner item id. The operation's `itemId` is the block id. */
  itemId?: string;
  scheduledFor?: string | null;
  estimateMinutes?: number;
  actualMinutes?: number | null;
  carriedOver?: number;
  completedAt?: string | null;
  updatedAt?: PlannerWireHlc;
}

interface PlannerPushOperationBase {
  idempotencyKey: string;
  /** Target record id. For block operations this is the block id. */
  itemId: string;
  at: PlannerWireHlc;
  attempts?: number;
  lastError?: string;
  retryRequestedAt?: string;
}

export interface PlannerItemMutationOperation extends PlannerPushOperationBase {
  /** Missing means `item`, preserving the original planner wire contract. */
  entity?: 'item';
  kind: PlannerItemMutationKind;
  payload: PlannerItemWirePayload;
}

export interface PlannerConflictResolutionOperation extends PlannerPushOperationBase {
  /** Missing means `item`, preserving the original planner wire contract. */
  entity?: 'item';
  kind: 'resolve_conflict';
  payload: PlannerConflictResolutionWirePayload;
}

export type PlannerItemPushOperation =
  | PlannerItemMutationOperation
  | PlannerConflictResolutionOperation;

export interface PlannerBlockPushOperation extends PlannerPushOperationBase {
  entity: 'block';
  kind: PlannerBlockOperationKind;
  payload: PlannerBlockWirePayload;
}

export type PlannerPushOperation = PlannerItemPushOperation | PlannerBlockPushOperation;

export interface PlannerOperationRejection {
  idempotencyKey: string;
  reason: string;
}

export interface PlannerPushOutcome {
  accepted: string[];
  rejected: PlannerOperationRejection[];
}

export interface PlannerPullEnvelope<TItem, TBlock> {
  items: TItem[];
  blocks: TBlock[];
  cursor: string;
  serverClock?: PlannerWireHlc;
}
