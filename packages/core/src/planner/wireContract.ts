/**
 * ADR-038 D3/D4 — runtime validation and normalization for planner sync.
 *
 * The public wire shapes live in the browser-safe types package. This module
 * is the one validation boundary used by HTTP and direct backend callers, so a
 * malformed block can never fall through the legacy item-patch path.
 */
import type {
  PlannerBlockPushOperation,
  PlannerBlockWirePayload,
  PlannerConflictResolutionOperation,
  PlannerConflictResolutionWirePayload,
  PlannerItemPushOperation,
  PlannerItemMutationOperation,
  PlannerItemWirePayload,
  PlannerProvenance,
  PlannerPushOperation,
  PlannerWireHlc,
} from '@kinqs/brainrouter-types/planner';

export type {
  PlannerBlockPushOperation,
  PlannerBlockWirePayload,
  PlannerConflictField,
  PlannerConflictResolutionOperation,
  PlannerConflictResolutionWirePayload,
  PlannerItemPushOperation,
  PlannerItemMutationOperation,
  PlannerItemWirePayload,
  PlannerOperationEntity,
  PlannerOperationRejection,
  PlannerProvenance,
  PlannerPullEnvelope,
  PlannerPushOperation,
  PlannerPushOutcome,
} from '@kinqs/brainrouter-types/planner';

export interface NormalizedPlannerItemPayload {
  origin?: 'owned' | 'mirrored';
  source?: string;
  fetchedAt?: string;
  provenance?: PlannerProvenance;
  title?: string;
  titleSeen?: PlannerWireHlc[];
  notes?: string;
  notesSeen?: PlannerWireHlc[];
  dueDate?: string | null;
  priority?: number;
  completed?: boolean;
  estimateMinutes?: number;
  blockedReason?: string | null;
}

export interface ValidatedPlannerItemMutationOperation extends Omit<PlannerItemMutationOperation, 'payload'> {
  entity: 'item';
  payload: NormalizedPlannerItemPayload;
}

export interface ValidatedPlannerConflictResolutionOperation
  extends Omit<PlannerConflictResolutionOperation, 'payload'> {
  entity: 'item';
  payload: PlannerConflictResolutionWirePayload;
}

export type ValidatedPlannerItemOperation =
  | ValidatedPlannerItemMutationOperation
  | ValidatedPlannerConflictResolutionOperation;

export interface NormalizedPlannerBlockPayload {
  itemId?: string;
  scheduledFor?: string | null;
  estimateMinutes?: number;
  actualMinutes?: number | null;
  carriedOver?: number;
  completedAt?: string | null;
}

export interface ValidatedPlannerBlockOperation extends Omit<PlannerBlockPushOperation, 'payload'> {
  payload: NormalizedPlannerBlockPayload;
}

export type ValidatedPlannerOperation = ValidatedPlannerItemOperation | ValidatedPlannerBlockOperation;

export type PlannerOperationValidation =
  | { ok: true; operation: ValidatedPlannerOperation }
  | { ok: false; idempotencyKey: string; reason: string };

const MAX_KEY_LENGTH = 500;
const MAX_ID_LENGTH = 500;
const MAX_SHORT_TEXT = 2_000;
const MAX_NOTES_LENGTH = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isPlannerWireHlc(value: unknown): value is PlannerWireHlc {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.physical) && Number(value.physical) >= 0
    && Number(value.physical) <= 8_640_000_000_000_000
    && Number.isSafeInteger(value.logical) && Number(value.logical) >= 0
    && typeof value.deviceId === 'string'
    && value.deviceId.length > 0
    && value.deviceId.length <= 200;
}

function operationKey(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.idempotencyKey !== 'string') return 'unknown';
  return raw.idempotencyKey.slice(0, MAX_KEY_LENGTH);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function unwrapStamped(value: unknown):
  | { ok: true; value: unknown; seen?: PlannerWireHlc[] }
  | { ok: false } {
  if (!isRecord(value) || !Object.hasOwn(value, 'value')) return { ok: true, value };
  if (Object.keys(value).some((key) => key !== 'value' && key !== 'at' && key !== 'seen')) {
    return { ok: false };
  }
  if (!isPlannerWireHlc(value.at)) return { ok: false };
  if (value.seen !== undefined) {
    if (!Array.isArray(value.seen) || value.seen.length > 64 || !value.seen.every(isPlannerWireHlc)) {
      return { ok: false };
    }
    const devices = new Set(value.seen.map((stamp) => stamp.deviceId));
    if (devices.size !== value.seen.length) return { ok: false };
    return { ok: true, value: value.value, seen: value.seen };
  }
  return { ok: true, value: value.value };
}

function readField(
  payload: Record<string, unknown>,
  name: string,
  validate: (value: unknown) => boolean,
): { ok: true; present: boolean; value?: unknown; seen?: PlannerWireHlc[] } | { ok: false } {
  if (!Object.hasOwn(payload, name)) return { ok: true, present: false };
  const unwrapped = unwrapStamped(payload[name]);
  if (!unwrapped.ok || !validate(unwrapped.value)) return { ok: false };
  return { ok: true, present: true, value: unwrapped.value, ...(unwrapped.seen ? { seen: unwrapped.seen } : {}) };
}

function parseProvenance(value: unknown): PlannerProvenance | null {
  if (!isRecord(value)) return null;
  if (!validText(value.sourceId, 200) || !value.sourceId.trim()) return null;
  if (!validText(value.sourceLabel, 500) || !value.sourceLabel.trim()) return null;
  if (!validText(value.fetchedAt, 100) || !validIso(value.fetchedAt)) return null;
  if (value.externalId !== undefined && !validText(value.externalId, MAX_ID_LENGTH)) return null;
  if (value.sourceUrl !== undefined) {
    if (!validText(value.sourceUrl, 4_000)) return null;
    try {
      const url = new URL(value.sourceUrl);
      if (url.protocol !== 'https:') return null;
    } catch {
      return null;
    }
  }
  return {
    sourceId: value.sourceId,
    sourceLabel: value.sourceLabel,
    fetchedAt: value.fetchedAt,
    ...(typeof value.externalId === 'string' ? { externalId: value.externalId } : {}),
    ...(typeof value.sourceUrl === 'string' ? { sourceUrl: value.sourceUrl } : {}),
  };
}

function normalizeItemPayload(payload: Record<string, unknown>):
  | { ok: true; payload: NormalizedPlannerItemPayload }
  | { ok: false; reason: string } {
  const title = readField(payload, 'title', (value) => validText(value, MAX_SHORT_TEXT));
  const notes = readField(payload, 'notes', (value) => validText(value, MAX_NOTES_LENGTH));
  const dueDate = readField(
    payload,
    'dueDate',
    (value) => value === null || (validText(value, 100) && validIso(value)),
  );
  const priority = readField(payload, 'priority', (value) => typeof value === 'number' && Number.isFinite(value));
  const completed = readField(payload, 'completed', (value) => typeof value === 'boolean');
  const estimate = readField(
    payload,
    'estimateMinutes',
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  const blocked = readField(
    payload,
    'blockedReason',
    (value) => value === null || validText(value, MAX_SHORT_TEXT),
  );
  const fields = { title, notes, dueDate, priority, completed, estimate, blocked };
  const badField = Object.entries(fields).find(([, result]) => !result.ok)?.[0];
  if (badField) return { ok: false, reason: `The item payload has an invalid ${badField} field.` };

  if (payload.origin !== undefined && payload.origin !== 'owned' && payload.origin !== 'mirrored') {
    return { ok: false, reason: 'The item payload has an invalid origin.' };
  }
  if (payload.source !== undefined && !validText(payload.source, 200)) {
    return { ok: false, reason: 'The item payload has an invalid source.' };
  }
  if (payload.fetchedAt !== undefined && (!validText(payload.fetchedAt, 100) || !validIso(payload.fetchedAt))) {
    return { ok: false, reason: 'The item payload has an invalid fetchedAt value.' };
  }
  for (const field of ['externalId', 'sourceLabel'] as const) {
    if (payload[field] !== undefined && !validText(payload[field], field === 'externalId' ? MAX_ID_LENGTH : 500)) {
      return { ok: false, reason: `The item payload has an invalid ${field} field.` };
    }
  }
  if (payload.sourceUrl !== undefined) {
    if (!validText(payload.sourceUrl, 4_000)) {
      return { ok: false, reason: 'The item payload has an invalid sourceUrl field.' };
    }
    try {
      const url = new URL(payload.sourceUrl);
      if (url.protocol !== 'https:') {
        return { ok: false, reason: 'The item payload has an invalid sourceUrl field.' };
      }
    } catch {
      return { ok: false, reason: 'The item payload has an invalid sourceUrl field.' };
    }
  }

  let provenance: PlannerProvenance | undefined;
  if (payload.provenance !== undefined) {
    provenance = parseProvenance(payload.provenance) ?? undefined;
    if (!provenance) return { ok: false, reason: 'The item payload has invalid provenance.' };
  } else if (typeof payload.source === 'string') {
    const fetchedAt = typeof payload.fetchedAt === 'string' ? payload.fetchedAt : undefined;
    if (fetchedAt) {
      const legacy = parseProvenance({
        sourceId: payload.source,
        sourceLabel: typeof payload.sourceLabel === 'string' ? payload.sourceLabel : payload.source,
        fetchedAt,
        ...(typeof payload.externalId === 'string' ? { externalId: payload.externalId } : {}),
        ...(typeof payload.sourceUrl === 'string' ? { sourceUrl: payload.sourceUrl } : {}),
      });
      if (!legacy) return { ok: false, reason: 'The item payload has invalid source provenance.' };
      provenance = legacy;
    }
  }

  const normalized: NormalizedPlannerItemPayload = {
    ...(payload.origin === 'owned' || payload.origin === 'mirrored' ? { origin: payload.origin } : {}),
    ...(typeof payload.source === 'string' ? { source: payload.source } : {}),
    ...(typeof payload.fetchedAt === 'string' ? { fetchedAt: payload.fetchedAt } : {}),
    ...(provenance ? { provenance } : {}),
  };
  if (title.ok && title.present) normalized.title = title.value as string;
  if (title.ok && title.seen) normalized.titleSeen = title.seen;
  if (notes.ok && notes.present) normalized.notes = notes.value as string;
  if (notes.ok && notes.seen) normalized.notesSeen = notes.seen;
  if (dueDate.ok && dueDate.present) normalized.dueDate = dueDate.value as string | null;
  if (priority.ok && priority.present) normalized.priority = priority.value as number;
  if (completed.ok && completed.present) normalized.completed = completed.value as boolean;
  if (estimate.ok && estimate.present) normalized.estimateMinutes = estimate.value as number;
  if (blocked.ok && blocked.present) normalized.blockedReason = blocked.value as string | null;
  return { ok: true, payload: normalized };
}

function normalizeBlockPayload(payload: Record<string, unknown>):
  | { ok: true; payload: NormalizedPlannerBlockPayload }
  | { ok: false; reason: string } {
  const normalized: NormalizedPlannerBlockPayload = {};
  if (payload.itemId !== undefined) {
    if (!validText(payload.itemId, MAX_ID_LENGTH) || !payload.itemId.trim()) {
      return { ok: false, reason: 'The block payload has an invalid parent item id.' };
    }
    normalized.itemId = payload.itemId;
  }
  if (payload.scheduledFor !== undefined) {
    if (payload.scheduledFor !== null && (!validText(payload.scheduledFor, 100) || !validIso(payload.scheduledFor))) {
      return { ok: false, reason: 'The block payload has an invalid scheduledFor value.' };
    }
    normalized.scheduledFor = payload.scheduledFor as string | null;
  }
  if (payload.estimateMinutes !== undefined) {
    if (typeof payload.estimateMinutes !== 'number' || !Number.isFinite(payload.estimateMinutes)
      || payload.estimateMinutes <= 0) {
      return { ok: false, reason: 'The block payload needs a positive estimate.' };
    }
    normalized.estimateMinutes = payload.estimateMinutes;
  }
  if (payload.actualMinutes !== undefined) {
    if (payload.actualMinutes !== null && (typeof payload.actualMinutes !== 'number'
      || !Number.isFinite(payload.actualMinutes) || payload.actualMinutes < 0)) {
      return { ok: false, reason: 'The block payload has an invalid actualMinutes value.' };
    }
    normalized.actualMinutes = payload.actualMinutes as number | null;
  }
  if (payload.carriedOver !== undefined) {
    if (!Number.isSafeInteger(payload.carriedOver) || Number(payload.carriedOver) < 0) {
      return { ok: false, reason: 'The block payload has an invalid carriedOver value.' };
    }
    normalized.carriedOver = Number(payload.carriedOver);
  }
  if (payload.completedAt !== undefined) {
    if (payload.completedAt !== null && (!validText(payload.completedAt, 100) || !validIso(payload.completedAt))) {
      return { ok: false, reason: 'The block payload has an invalid completedAt value.' };
    }
    normalized.completedAt = payload.completedAt as string | null;
  }
  return { ok: true, payload: normalized };
}

/** Validate an untrusted operation and normalize legacy item payloads. */
export function validatePlannerOperation(raw: unknown): PlannerOperationValidation {
  const idempotencyKey = operationKey(raw);
  if (!isRecord(raw)) return { ok: false, idempotencyKey, reason: 'The operation must be an object.' };
  if (!validText(raw.idempotencyKey, MAX_KEY_LENGTH) || !raw.idempotencyKey.trim()) {
    return { ok: false, idempotencyKey, reason: 'The operation has an invalid idempotency key.' };
  }
  if (!validText(raw.itemId, MAX_ID_LENGTH) || !raw.itemId.trim()) {
    return { ok: false, idempotencyKey, reason: 'The operation has an invalid target id.' };
  }
  if (!isPlannerWireHlc(raw.at)) {
    return { ok: false, idempotencyKey, reason: 'The operation has an invalid hybrid-clock stamp.' };
  }
  if (!isRecord(raw.payload)) {
    return { ok: false, idempotencyKey, reason: 'The operation carried no usable payload.' };
  }

  if (raw.entity === 'block') {
    if (raw.kind !== 'create' && raw.kind !== 'update') {
      return { ok: false, idempotencyKey, reason: 'A block operation must be create or update.' };
    }
    const payload = normalizeBlockPayload(raw.payload);
    if (!payload.ok) return { ok: false, idempotencyKey, reason: payload.reason };
    return {
      ok: true,
      operation: {
        idempotencyKey: raw.idempotencyKey,
        itemId: raw.itemId,
        entity: 'block',
        kind: raw.kind,
        at: raw.at,
        payload: payload.payload,
      },
    };
  }

  if (raw.entity !== undefined && raw.entity !== 'item') {
    return { ok: false, idempotencyKey, reason: 'The operation has an unknown entity type.' };
  }
  if (raw.kind === 'resolve_conflict') {
    const payloadKeys = Object.keys(raw.payload);
    if (raw.payload.field === 'deleted') {
      if (payloadKeys.length !== 2 || !payloadKeys.includes('field') || !payloadKeys.includes('keep')
        || (raw.payload.keep !== 'ours' && raw.payload.keep !== 'theirs')) {
        return { ok: false, idempotencyKey, reason: 'A deleted conflict resolution must carry exactly field and keep.' };
      }
      return {
        ok: true,
        operation: {
          idempotencyKey: raw.idempotencyKey,
          itemId: raw.itemId,
          entity: 'item',
          kind: 'resolve_conflict',
          at: raw.at,
          payload: { field: 'deleted', keep: raw.payload.keep },
        },
      };
    }
    if (raw.payload.field !== 'title' && raw.payload.field !== 'notes') {
      return { ok: false, idempotencyKey, reason: 'A conflict resolution must name title, notes, or deleted.' };
    }
    if (!validText(raw.payload.value, raw.payload.field === 'notes' ? MAX_NOTES_LENGTH : MAX_SHORT_TEXT)) {
      return { ok: false, idempotencyKey, reason: 'A conflict resolution has an invalid value.' };
    }
    if (payloadKeys.length !== 2 || !payloadKeys.includes('field') || !payloadKeys.includes('value')) {
      return { ok: false, idempotencyKey, reason: 'A text conflict resolution payload only accepts field and value.' };
    }
    return {
      ok: true,
      operation: {
        idempotencyKey: raw.idempotencyKey,
        itemId: raw.itemId,
        entity: 'item',
        kind: 'resolve_conflict',
        at: raw.at,
        payload: { field: raw.payload.field, value: raw.payload.value },
      },
    };
  }
  if (raw.kind !== 'create' && raw.kind !== 'update' && raw.kind !== 'delete' && raw.kind !== 'source_action') {
    return { ok: false, idempotencyKey, reason: 'The item operation has an invalid kind.' };
  }
  const payload = normalizeItemPayload(raw.payload);
  if (!payload.ok) return { ok: false, idempotencyKey, reason: payload.reason };
  return {
    ok: true,
    operation: {
      idempotencyKey: raw.idempotencyKey,
      itemId: raw.itemId,
      entity: 'item',
      kind: raw.kind,
      at: raw.at,
      payload: payload.payload,
    },
  };
}

/** Narrow a typed value after it crossed an untrusted JSON boundary. */
export function isPlannerPushOperation(value: unknown): value is PlannerPushOperation {
  return validatePlannerOperation(value).ok;
}
