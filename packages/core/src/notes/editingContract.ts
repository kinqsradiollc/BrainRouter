/**
 * ADR-038 — the browser-safe Notes editing transport.
 *
 * A renderer sends one gesture in this envelope and the host decides how to
 * persist it. The operation vocabulary is shared by Dashboard and Desktop; it
 * deliberately contains intentions such as `gesture.split`, not a collection
 * of ad-hoc block patches. Core's pure planners turn those intentions into the
 * same primitive writes on every host.
 *
 * Runtime validation lives beside the TypeScript types because HTTP receives
 * values, not types. A caller may import this file through
 * `@kinqs/brainrouter-core/notes/editing`: it has no Node or store dependency.
 */
import { NOTE_BLOCK_KINDS, type NoteBlockKind } from './block.js';
import {
  isNoteViewKind, MAX_FILTER_RULES, OPERATORS_FOR_TYPE,
  type NoteDatabaseView, type NoteViewKind,
} from './databaseView.js';
import {
  isNotePropertyType, isNoteRollupAggregate, MAX_DATABASE_PROPERTIES,
  MAX_PROPERTY_TEXT, MAX_PROPERTY_VALUES,
  type NotePropertyDef, type NotePropertyType, type NotePropertyValue,
  type NoteRollupSpec, type NoteSelectOption,
} from './properties.js';
import { MAX_COMMENT_AUTHOR, MAX_COMMENT_LENGTH } from './comment.js';
import type { Hlc } from '../sync/hybridClock.js';

export const NOTES_EDITING_CONTRACT_VERSION = 1 as const;
export type NotesEditingContractVersion = typeof NOTES_EDITING_CONTRACT_VERSION;

/** Kept in Core so the browser validator and server validator cannot drift. */
export const MAX_NOTE_MUTATION_TEXT = 100_000;
export const MAX_NOTE_MUTATION_META_TEXT = 2_048;
export const MAX_NOTE_MUTATION_ID = 256;
export const MAX_NOTE_MUTATION_REQUEST_ID = 128;
export const MAX_NOTE_MUTATION_DEVICE_ID = 128;

export interface NoteMutationPosition {
  parentId?: string | null;
  after?: string;
  before?: string;
}

export interface NoteMutationBlockFields {
  text?: string;
  kind?: NoteBlockKind;
  level?: number;
  checked?: boolean;
  language?: string;
  collapsed?: boolean;
  icon?: string;
  cover?: string;
  favourite?: boolean;
  template?: boolean;
  props?: Record<string, NotePropertyValue>;
  schema?: readonly NotePropertyDef[];
  views?: readonly NoteDatabaseView[];
}

/** Generic block writes cannot bypass the dedicated database mutation policy. */
export type NoteMutationDirectBlockFields = Omit<
  NoteMutationBlockFields,
  'props' | 'schema' | 'views'
>;

export interface NoteMutationCreateInput extends NoteMutationDirectBlockFields, NoteMutationPosition {
  /** Optional client-minted id. The host otherwise derives one from `requestId`. */
  blockId?: string;
}

export interface NoteMutationPropertyInput {
  id?: string;
  name: string;
  type: NotePropertyType;
  options?: readonly NoteSelectOption[];
  description?: string;
  formula?: string;
  rollup?: NoteRollupSpec;
}

export interface NoteMutationPropertyPatch {
  name?: string;
  options?: readonly NoteSelectOption[];
  description?: string;
  formula?: string;
  rollup?: NoteRollupSpec;
}

export interface NoteMutationViewInput {
  id?: string;
  name?: string;
  kind?: NoteViewKind;
  visible?: readonly string[];
  /** `null` clears a saved filter; `undefined` leaves it unchanged. */
  filter?: NoteDatabaseView['filter'] | null;
  sort?: NoteDatabaseView['sort'];
  groupBy?: string | null;
}

export type NotesMutationOperation =
  | { type: 'block.create'; input: NoteMutationCreateInput }
  | {
      type: 'block.update'; blockId: string; patch: NoteMutationDirectBlockFields;
      leaseEpoch?: number;
    }
  | { type: 'block.delete'; blockId: string }
  | { type: 'block.restore'; blockId: string }
  | { type: 'block.move'; blockId: string; to: NoteMutationPosition }
  | { type: 'gesture.split'; blockId: string; caret: number; leaseEpoch?: number }
  | { type: 'gesture.merge'; blockId: string; leaseEpoch?: number }
  | { type: 'gesture.duplicate'; blockId: string }
  | { type: 'gesture.indent'; blockId: string }
  | { type: 'gesture.outdent'; blockId: string }
  | { type: 'gesture.move'; blockId: string; direction: -1 | 1 }
  | { type: 'lease.acquire'; blockId: string; holder?: string }
  | { type: 'lease.renew'; blockId: string; epoch: number }
  | { type: 'lease.release'; blockId: string; epoch: number }
  | { type: 'comment.add'; blockId: string; body: string; author?: string; commentId?: string }
  | { type: 'comment.edit'; blockId: string; commentId: string; body: string }
  | { type: 'comment.resolve'; blockId: string; commentId: string; resolved: boolean }
  | { type: 'comment.delete'; blockId: string; commentId: string }
  | {
      type: 'conflict.resolve'; blockId: string; field: string; keep: 'ours' | 'theirs';
      /** The exact kept-both pair the person saw; newer conflicts are never cleared by a stale click. */
      expected: { oursAt: Hlc; theirsAt: Hlc };
    }
  | { type: 'template.instantiate'; templateId: string; parentId: string | null }
  | {
      type: 'database.row.create'; databaseId: string; rowId?: string; title?: string;
      values?: Record<string, unknown>; after?: string; before?: string;
    }
  | {
      type: 'database.row.set'; rowId: string; propertyId: string; value: unknown;
      leaseEpoch?: number;
    }
  | { type: 'database.row.delete'; rowId: string }
  | { type: 'database.property.add'; databaseId: string; property: NoteMutationPropertyInput; leaseEpoch?: number }
  | {
      type: 'database.property.update'; databaseId: string; propertyId: string;
      patch: NoteMutationPropertyPatch; leaseEpoch?: number;
    }
  | { type: 'database.property.delete'; databaseId: string; propertyId: string; leaseEpoch?: number }
  | { type: 'database.property.reorder'; databaseId: string; order: readonly string[]; leaseEpoch?: number }
  | { type: 'database.view.save'; databaseId: string; view: NoteMutationViewInput; leaseEpoch?: number }
  | { type: 'database.view.delete'; databaseId: string; viewId: string; leaseEpoch?: number }
  | { type: 'history.state'; pageId?: string | null }
  | { type: 'history.undo'; pageId?: string | null }
  | { type: 'history.redo'; pageId?: string | null }
  /** Native bytes need an upload transport; JSON mutation bodies never pretend otherwise. */
  | { type: 'attachment.upload-bytes'; blockId: string; fileName: string; mediaType: string; byteSize: number };

export type NotesMutationOperationType = NotesMutationOperation['type'];

export interface NotesMutationRequest {
  version: NotesEditingContractVersion;
  /** Stable across retries. It is the root of every server idempotency key. */
  requestId: string;
  /** Stable editor/device id. It is also the identity checked by a lease fence. */
  deviceId: string;
  operation: NotesMutationOperation;
}

export interface NotesMutationSyncReport {
  accepted: string[];
  rejected: Array<{ idempotencyKey: string; reason: string }>;
  fenced: Array<{ idempotencyKey: string; itemId: string; reason: string }>;
}

export interface NotesRemoteHistoryState {
  scope: 'remote';
  canUndo: false;
  canRedo: false;
  reason: 'remote_history_unavailable';
  detail: string;
}

export type NotesMutationErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'locked'
  | 'refused'
  | 'unsupported_capability'
  | 'idempotency_conflict'
  | 'stale_conflict'
  | 'limit_exceeded'
  | 'sync_rejected'
  | 'internal_error';

export interface NotesMutationError {
  code: NotesMutationErrorCode;
  detail: string;
  retryable: boolean;
  capability?: 'remote_history' | 'attachment_bytes';
}

export interface NotesMutationSuccess {
  version: NotesEditingContractVersion;
  requestId: string;
  operation: NotesMutationOperationType;
  ok: true;
  /** Operation-specific JSON value: a block, comment, lease, gesture result, etc. */
  result: unknown;
  sync: NotesMutationSyncReport;
  history: NotesRemoteHistoryState;
}

export interface NotesMutationFailure {
  version: NotesEditingContractVersion;
  requestId: string;
  operation: NotesMutationOperationType | 'unknown';
  ok: false;
  error: NotesMutationError;
  sync: NotesMutationSyncReport;
  history: NotesRemoteHistoryState;
}

export type NotesMutationResponse = NotesMutationSuccess | NotesMutationFailure;

export interface NotesEditingCapabilities {
  version: NotesEditingContractVersion;
  endpoint: '/api/notes/mutate';
  operations: Readonly<Record<NotesMutationOperationType, boolean>>;
  history: {
    scope: 'remote';
    state: true;
    undo: false;
    redo: false;
    reason: 'remote_history_unavailable';
  };
  attachments: {
    metadata: true;
    bytes: false;
    reason: 'attachment_bytes_require_upload_transport';
  };
}

const REMOTE_OPERATIONS: readonly NotesMutationOperationType[] = [
  'block.create', 'block.update', 'block.delete', 'block.restore', 'block.move',
  'gesture.split', 'gesture.merge', 'gesture.duplicate', 'gesture.indent',
  'gesture.outdent', 'gesture.move',
  'lease.acquire', 'lease.renew', 'lease.release',
  'comment.add', 'comment.edit', 'comment.resolve', 'comment.delete',
  'conflict.resolve', 'template.instantiate',
  'database.row.create', 'database.row.set', 'database.row.delete',
  'database.property.add', 'database.property.update', 'database.property.delete',
  'database.property.reorder', 'database.view.save', 'database.view.delete',
  'history.state', 'history.undo', 'history.redo', 'attachment.upload-bytes',
];

export const NOTES_EDITING_CAPABILITIES: NotesEditingCapabilities = {
  version: NOTES_EDITING_CONTRACT_VERSION,
  endpoint: '/api/notes/mutate',
  operations: Object.freeze(Object.fromEntries(REMOTE_OPERATIONS.map((type) => [
    type,
    type !== 'history.undo' && type !== 'history.redo' && type !== 'attachment.upload-bytes',
  ]))) as Readonly<Record<NotesMutationOperationType, boolean>>,
  history: {
    scope: 'remote', state: true, undo: false, redo: false,
    reason: 'remote_history_unavailable',
  },
  attachments: {
    metadata: true, bytes: false,
    reason: 'attachment_bytes_require_upload_transport',
  },
};

export const EMPTY_NOTES_MUTATION_SYNC: NotesMutationSyncReport = {
  accepted: [], rejected: [], fenced: [],
};

export const REMOTE_NOTES_HISTORY_STATE: NotesRemoteHistoryState = {
  scope: 'remote',
  canUndo: false,
  canRedo: false,
  reason: 'remote_history_unavailable',
  detail: 'Undo history belongs to one local device and is not replayed by the shared server.',
};

export type NotesMutationParseResult =
  | { ok: true; value: NotesMutationRequest }
  | { ok: false; error: { path: string; detail: string } };

const record = (value: unknown): Record<string, unknown> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.fromEntries(Object.entries(value)) as Record<string, unknown>;
};

/** Return only own JSON data, on inert null-prototype maps. */
function normalizeOwnData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOwnData);
  if (value !== null && typeof value === 'object') {
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) normalized[key] = normalizeOwnData(entry);
    return normalized;
  }
  return value;
}

const DIRECT_BLOCK_FIELD_KEYS = new Set([
  'text', 'kind', 'level', 'checked', 'language', 'collapsed', 'icon', 'cover',
  'favourite', 'template',
]);
const FILTER_OPERATORS = new Set<string>(Object.values(OPERATORS_FOR_TYPE).flat());

function onlyKeysAt(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): string | null {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  return unknown ? `${path}.${unknown} is not part of the Notes mutation contract.` : null;
}

function stringAt(
  value: unknown,
  path: string,
  max: number,
  opts: { empty?: boolean } = {},
): string | null {
  if (typeof value !== 'string') return `${path} must be a string.`;
  if (!opts.empty && value.trim().length === 0) return `${path} must not be empty.`;
  if (value.length > max) return `${path} must be at most ${max} characters.`;
  return null;
}

function idAt(value: unknown, path: string, optional = false): string | null {
  if (optional && value === undefined) return null;
  const invalid = stringAt(value, path, MAX_NOTE_MUTATION_ID);
  if (invalid) return invalid;
  const id = value as string;
  if (/[\u0000-\u001f\u007f]/u.test(id)) return `${path} must not contain control characters.`;
  return id === '__proto__' || id === 'prototype' || id === 'constructor'
    ? `${path} is a reserved object key.`
    : null;
}

function tokenAt(value: unknown, path: string, max: number): string | null {
  const invalid = stringAt(value, path, max);
  if (invalid) return invalid;
  return /[\u0000-\u001f\u007f]/u.test(value as string)
    ? `${path} must not contain control characters.`
    : null;
}

function epochAt(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? null
    : `${path} must be a positive integer.`;
}

function hlcAt(value: unknown, path: string): string | null {
  const clock = record(value);
  if (!clock) return `${path} must be an object.`;
  const unknown = onlyKeysAt(clock, new Set(['physical', 'logical', 'deviceId']), path);
  if (unknown) return unknown;
  for (const key of ['physical', 'logical'] as const) {
    if (typeof clock[key] !== 'number' || !Number.isSafeInteger(clock[key]) || clock[key] < 0) {
      return `${path}.${key} must be a non-negative safe integer.`;
    }
  }
  return tokenAt(clock.deviceId, `${path}.deviceId`, MAX_NOTE_MUTATION_DEVICE_ID);
}

function positionAt(
  value: unknown,
  path: string,
  extraKeys: readonly string[] = [],
): string | null {
  const at = record(value);
  if (!at) return `${path} must be an object.`;
  const unknown = onlyKeysAt(at, new Set(['parentId', 'after', 'before', ...extraKeys]), path);
  if (unknown) return unknown;
  if (at.parentId !== undefined && at.parentId !== null) {
    const invalid = idAt(at.parentId, `${path}.parentId`);
    if (invalid) return invalid;
  }
  for (const key of ['after', 'before'] as const) {
    if (at[key] !== undefined) {
      const invalid = idAt(at[key], `${path}.${key}`);
      if (invalid) return invalid;
    }
  }
  if (at.after !== undefined && at.before !== undefined) {
    return `${path} may name after or before, not both.`;
  }
  return null;
}

function propertyValueAt(value: unknown, path: string): string | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} must be finite.`;
  if (typeof value === 'string') {
    return value.length <= MAX_PROPERTY_TEXT
      ? null
      : `${path} must be at most ${MAX_PROPERTY_TEXT} characters.`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PROPERTY_VALUES) return `${path} holds at most ${MAX_PROPERTY_VALUES} values.`;
    for (let index = 0; index < value.length; index += 1) {
      const invalid = stringAt(value[index], `${path}[${index}]`, MAX_PROPERTY_TEXT, { empty: true });
      if (invalid) return invalid;
    }
    return null;
  }
  return `${path} must be text, a finite number, a boolean, a string list, or null.`;
}

function optionListAt(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path} must be an array.`;
  if (value.length > MAX_PROPERTY_VALUES) {
    return `${path} holds at most ${MAX_PROPERTY_VALUES} options.`;
  }
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const option = record(value[index]);
    if (!option) return `${path}[${index}] must be an object.`;
    const unknown = onlyKeysAt(option, new Set(['id', 'label', 'tone']), `${path}[${index}]`);
    if (unknown) return unknown;
    const idInvalid = idAt(option.id, `${path}[${index}].id`);
    if (idInvalid) return idInvalid;
    const labelInvalid = stringAt(option.label, `${path}[${index}].label`, MAX_PROPERTY_TEXT);
    if (labelInvalid) return labelInvalid;
    if (option.tone !== undefined) {
      const toneInvalid = stringAt(option.tone, `${path}[${index}].tone`, MAX_NOTE_MUTATION_META_TEXT);
      if (toneInvalid) return toneInvalid;
    }
    if (ids.has(option.id as string)) return `${path} contains duplicate option id ${String(option.id)}.`;
    ids.add(option.id as string);
  }
  return null;
}

function rollupAt(value: unknown, path: string): string | null {
  const rollup = record(value);
  if (!rollup) return `${path} must be an object.`;
  const unknown = onlyKeysAt(rollup, new Set(['relation', 'target', 'aggregate']), path);
  if (unknown) return unknown;
  return idAt(rollup.relation, `${path}.relation`)
    ?? idAt(rollup.target, `${path}.target`)
    ?? (isNoteRollupAggregate(rollup.aggregate)
      ? null
      : `${path}.aggregate is not a supported rollup aggregate.`);
}

function filterAt(value: unknown, path: string): string | null {
  let visited = 0;
  const walk = (raw: unknown, at: string, depth: number): string | null => {
    const node = record(raw);
    if (!node) return `${at} must be an object.`;
    visited += 1;
    if (visited > MAX_FILTER_RULES) return `${path} holds at most ${MAX_FILTER_RULES} rules and groups.`;
    if (depth > 8) return `${path} nests at most 8 groups deep.`;
    if (node.combinator !== undefined || node.rules !== undefined) {
      const unknown = onlyKeysAt(node, new Set(['combinator', 'rules']), at);
      if (unknown) return unknown;
      if (node.combinator !== 'and' && node.combinator !== 'or') {
        return `${at}.combinator must be "and" or "or".`;
      }
      if (!Array.isArray(node.rules)) return `${at}.rules must be an array.`;
      for (let index = 0; index < node.rules.length; index += 1) {
        const invalid = walk(node.rules[index], `${at}.rules[${index}]`, depth + 1);
        if (invalid) return invalid;
      }
      return null;
    }
    const unknown = onlyKeysAt(node, new Set(['property', 'operator', 'value']), at);
    if (unknown) return unknown;
    const propertyInvalid = idAt(node.property, `${at}.property`);
    if (propertyInvalid) return propertyInvalid;
    if (typeof node.operator !== 'string' || !FILTER_OPERATORS.has(node.operator)) {
      return `${at}.operator is not a supported filter operator.`;
    }
    return node.value === undefined ? null : propertyValueAt(node.value, `${at}.value`);
  };
  return walk(value, path, 0);
}

function sortAt(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path} must be an array.`;
  if (value.length > MAX_FILTER_RULES) return `${path} holds at most ${MAX_FILTER_RULES} rules.`;
  for (let index = 0; index < value.length; index += 1) {
    const rule = record(value[index]);
    if (!rule) return `${path}[${index}] must be an object.`;
    const unknown = onlyKeysAt(rule, new Set(['property', 'direction']), `${path}[${index}]`);
    if (unknown) return unknown;
    const propertyInvalid = idAt(rule.property, `${path}[${index}].property`);
    if (propertyInvalid) return propertyInvalid;
    if (rule.direction !== 'asc' && rule.direction !== 'desc') {
      return `${path}[${index}].direction must be asc or desc.`;
    }
  }
  return null;
}

function blockFieldsAt(
  value: unknown,
  path: string,
  extraKeys: readonly string[] = [],
): string | null {
  const fields = record(value);
  if (!fields) return `${path} must be an object.`;
  const unknown = onlyKeysAt(fields, new Set([...DIRECT_BLOCK_FIELD_KEYS, ...extraKeys]), path);
  if (unknown) return unknown;
  if (fields.text !== undefined) {
    const invalid = stringAt(fields.text, `${path}.text`, MAX_NOTE_MUTATION_TEXT, { empty: true });
    if (invalid) return invalid;
  }
  if (fields.kind !== undefined && !NOTE_BLOCK_KINDS.includes(fields.kind as NoteBlockKind)) {
    return `${path}.kind is not a Notes block kind.`;
  }
  if (fields.level !== undefined && (
    typeof fields.level !== 'number' || !Number.isInteger(fields.level) || fields.level < 1 || fields.level > 6
  )) return `${path}.level must be an integer from 1 to 6.`;
  for (const key of ['checked', 'collapsed', 'favourite', 'template'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'boolean') {
      return `${path}.${key} must be true or false.`;
    }
  }
  for (const key of ['language', 'icon', 'cover'] as const) {
    if (fields[key] !== undefined) {
      const invalid = stringAt(fields[key], `${path}.${key}`, MAX_NOTE_MUTATION_META_TEXT, { empty: true });
      if (invalid) return invalid;
    }
  }
  return null;
}

function stringListAt(value: unknown, path: string, max = MAX_DATABASE_PROPERTIES): string | null {
  if (!Array.isArray(value)) return `${path} must be an array.`;
  if (value.length > max) return `${path} holds at most ${max} ids.`;
  for (let index = 0; index < value.length; index += 1) {
    const invalid = idAt(value[index], `${path}[${index}]`);
    if (invalid) return invalid;
  }
  return null;
}

function propertyInputAt(value: unknown, path: string, patch = false): string | null {
  const input = record(value);
  if (!input) return `${path} must be an object.`;
  const allowed = patch
    ? new Set(['name', 'options', 'description', 'formula', 'rollup'])
    : new Set(['id', 'name', 'type', 'options', 'description', 'formula', 'rollup']);
  const unknown = onlyKeysAt(input, allowed, path);
  if (unknown) return unknown;
  if (!patch || input.name !== undefined) {
    const invalid = stringAt(input.name, `${path}.name`, MAX_PROPERTY_TEXT);
    if (invalid) return invalid;
  }
  if (!patch && !isNotePropertyType(input.type)) return `${path}.type is not a writable property type.`;
  if (input.id !== undefined) {
    const invalid = idAt(input.id, `${path}.id`);
    if (invalid) return invalid;
  }
  if (input.description !== undefined) {
    const invalid = stringAt(input.description, `${path}.description`, MAX_PROPERTY_TEXT, { empty: true });
    if (invalid) return invalid;
  }
  if (input.formula !== undefined) {
    const invalid = stringAt(input.formula, `${path}.formula`, MAX_PROPERTY_TEXT, { empty: true });
    if (invalid) return invalid;
  }
  if (input.options !== undefined) {
    const invalid = optionListAt(input.options, `${path}.options`);
    if (invalid) return invalid;
  }
  if (input.rollup !== undefined) {
    const invalid = rollupAt(input.rollup, `${path}.rollup`);
    if (invalid) return invalid;
  }
  return null;
}

function viewInputAt(value: unknown, path: string): string | null {
  const view = record(value);
  if (!view) return `${path} must be an object.`;
  const unknown = onlyKeysAt(
    view,
    new Set(['id', 'name', 'kind', 'visible', 'filter', 'sort', 'groupBy']),
    path,
  );
  if (unknown) return unknown;
  if (view.id !== undefined) {
    const invalid = idAt(view.id, `${path}.id`);
    if (invalid) return invalid;
  }
  if (view.name !== undefined) {
    const invalid = stringAt(view.name, `${path}.name`, MAX_PROPERTY_TEXT);
    if (invalid) return invalid;
  }
  if (view.kind !== undefined && !isNoteViewKind(view.kind)) {
    return `${path}.kind is not a Notes view kind.`;
  }
  if (view.visible !== undefined) {
    const invalid = stringListAt(view.visible, `${path}.visible`);
    if (invalid) return invalid;
  }
  if (view.filter !== undefined && view.filter !== null) {
    const invalid = filterAt(view.filter, `${path}.filter`);
    if (invalid) return invalid;
  }
  if (view.sort !== undefined) {
    const invalid = sortAt(view.sort, `${path}.sort`);
    if (invalid) return invalid;
  }
  if (view.groupBy !== undefined && view.groupBy !== null) {
    const invalid = idAt(view.groupBy, `${path}.groupBy`);
    if (invalid) return invalid;
  }
  return null;
}

function commonBlockId(operation: Record<string, unknown>, path: string): string | null {
  return idAt(operation.blockId, `${path}.blockId`);
}

function validateOperation(operation: Record<string, unknown>): string | null {
  const type = operation.type;
  if (typeof type !== 'string' || !REMOTE_OPERATIONS.includes(type as NotesMutationOperationType)) {
    return 'operation.type is not a supported Notes mutation.';
  }
  const path = 'operation';

  if (type === 'block.create') {
    const input = record(operation.input);
    if (!input) return `${path}.input must be an object.`;
    const positionInvalid = positionAt(
      input,
      `${path}.input`,
      [...DIRECT_BLOCK_FIELD_KEYS, 'blockId'],
    );
    if (positionInvalid) return positionInvalid;
    const fieldsInvalid = blockFieldsAt(
      input,
      `${path}.input`,
      ['blockId', 'parentId', 'after', 'before'],
    );
    return fieldsInvalid ?? idAt(input.blockId, `${path}.input.blockId`, true);
  }
  if (type === 'block.update') {
    return commonBlockId(operation, path)
      ?? blockFieldsAt(operation.patch, `${path}.patch`)
      ?? epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
  }
  if (type === 'block.delete' || type === 'block.restore') return commonBlockId(operation, path);
  if (type === 'block.move') {
    return commonBlockId(operation, path) ?? positionAt(operation.to, `${path}.to`);
  }
  if (type === 'gesture.split') {
    const invalid = commonBlockId(operation, path);
    if (invalid) return invalid;
    if (typeof operation.caret !== 'number' || !Number.isSafeInteger(operation.caret) || operation.caret < 0) {
      return `${path}.caret must be a non-negative integer.`;
    }
    return epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
  }
  if (type === 'gesture.merge') {
    return commonBlockId(operation, path) ?? epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
  }
  if (type === 'gesture.duplicate' || type === 'gesture.indent' || type === 'gesture.outdent') {
    return commonBlockId(operation, path);
  }
  if (type === 'gesture.move') {
    const invalid = commonBlockId(operation, path);
    if (invalid) return invalid;
    return operation.direction === -1 || operation.direction === 1
      ? null
      : `${path}.direction must be -1 or 1.`;
  }
  if (type.startsWith('lease.')) {
    const invalid = commonBlockId(operation, path);
    if (invalid) return invalid;
    if (type === 'lease.acquire') {
      return operation.holder === undefined
        ? null
        : stringAt(operation.holder, `${path}.holder`, MAX_COMMENT_AUTHOR);
    }
    return epochAt(operation.epoch, `${path}.epoch`);
  }
  if (type.startsWith('comment.')) {
    const invalid = commonBlockId(operation, path);
    if (invalid) return invalid;
    if (type !== 'comment.add') {
      const commentInvalid = idAt(operation.commentId, `${path}.commentId`);
      if (commentInvalid) return commentInvalid;
    } else if (operation.commentId !== undefined) {
      const commentInvalid = idAt(operation.commentId, `${path}.commentId`);
      if (commentInvalid) return commentInvalid;
    }
    if (type === 'comment.add' || type === 'comment.edit') {
      const bodyInvalid = stringAt(operation.body, `${path}.body`, MAX_COMMENT_LENGTH);
      if (bodyInvalid) return bodyInvalid;
    }
    if (type === 'comment.add' && operation.author !== undefined) {
      const authorInvalid = stringAt(operation.author, `${path}.author`, MAX_COMMENT_AUTHOR);
      if (authorInvalid) return authorInvalid;
    }
    if (type === 'comment.resolve' && typeof operation.resolved !== 'boolean') {
      return `${path}.resolved must be true or false.`;
    }
    return null;
  }
  if (type === 'conflict.resolve') {
    const field = operation.field;
    const commentId = typeof field === 'string' && field.startsWith('comment:')
      ? field.slice('comment:'.length)
      : null;
    const fieldInvalid = field === 'text' || field === 'deleted'
      ? null
      : commentId !== null
        ? idAt(commentId, `${path}.field comment id`)
        : `${path}.field must be text, deleted, or comment:<id>.`;
    const expected = record(operation.expected);
    const invalid = commonBlockId(operation, path) ?? fieldInvalid
      ?? (!expected ? `${path}.expected must be an object.` : null)
      ?? (expected ? onlyKeysAt(expected, new Set(['oursAt', 'theirsAt']), `${path}.expected`) : null)
      ?? (expected ? hlcAt(expected.oursAt, `${path}.expected.oursAt`) : null)
      ?? (expected ? hlcAt(expected.theirsAt, `${path}.expected.theirsAt`) : null);
    if (invalid) return invalid;
    return operation.keep === 'ours' || operation.keep === 'theirs'
      ? null
      : `${path}.keep must be "ours" or "theirs".`;
  }
  if (type === 'template.instantiate') {
    const invalid = idAt(operation.templateId, `${path}.templateId`);
    if (invalid) return invalid;
    return operation.parentId === null
      ? null
      : idAt(operation.parentId, `${path}.parentId`);
  }
  if (type === 'database.row.create') {
    const databaseInvalid = idAt(operation.databaseId, `${path}.databaseId`);
    if (databaseInvalid) return databaseInvalid;
    const rowInvalid = idAt(operation.rowId, `${path}.rowId`, true);
    if (rowInvalid) return rowInvalid;
    if (operation.title !== undefined) {
      const titleInvalid = stringAt(operation.title, `${path}.title`, MAX_NOTE_MUTATION_TEXT, { empty: true });
      if (titleInvalid) return titleInvalid;
    }
    if (operation.values !== undefined) {
      const values = record(operation.values);
      if (!values) return `${path}.values must be an object.`;
      if (Object.keys(values).length > MAX_DATABASE_PROPERTIES) {
        return `${path}.values may write at most ${MAX_DATABASE_PROPERTIES} properties.`;
      }
      for (const [propertyId, value] of Object.entries(values)) {
        const invalid = idAt(propertyId, `${path}.values key`)
          ?? propertyValueAt(value, `${path}.values.${propertyId}`);
        if (invalid) return invalid;
      }
    }
    if (operation.after !== undefined && operation.before !== undefined) return `${path} may name after or before, not both.`;
    for (const key of ['after', 'before'] as const) {
      if (operation[key] !== undefined) {
        const atInvalid = idAt(operation[key], `${path}.${key}`);
        if (atInvalid) return atInvalid;
      }
    }
    return null;
  }
  if (type === 'database.row.set') {
    return idAt(operation.rowId, `${path}.rowId`)
      ?? idAt(operation.propertyId, `${path}.propertyId`)
      ?? propertyValueAt(operation.value, `${path}.value`)
      ?? epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
  }
  if (type === 'database.row.delete') return idAt(operation.rowId, `${path}.rowId`);
  if (type.startsWith('database.property.')) {
    const invalid = idAt(operation.databaseId, `${path}.databaseId`)
      ?? epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
    if (invalid) return invalid;
    if (type === 'database.property.add') return propertyInputAt(operation.property, `${path}.property`);
    if (type === 'database.property.reorder') return stringListAt(operation.order, `${path}.order`);
    const propertyInvalid = idAt(operation.propertyId, `${path}.propertyId`);
    if (propertyInvalid) return propertyInvalid;
    return type === 'database.property.update'
      ? propertyInputAt(operation.patch, `${path}.patch`, true)
      : null;
  }
  if (type.startsWith('database.view.')) {
    const invalid = idAt(operation.databaseId, `${path}.databaseId`)
      ?? epochAt(operation.leaseEpoch, `${path}.leaseEpoch`);
    if (invalid) return invalid;
    return type === 'database.view.save'
      ? viewInputAt(operation.view, `${path}.view`)
      : idAt(operation.viewId, `${path}.viewId`);
  }
  if (type.startsWith('history.')) {
    return operation.pageId === undefined || operation.pageId === null
      ? null
      : idAt(operation.pageId, `${path}.pageId`);
  }
  if (type === 'attachment.upload-bytes') {
    const invalid = commonBlockId(operation, path)
      ?? stringAt(operation.fileName, `${path}.fileName`, MAX_PROPERTY_TEXT)
      ?? stringAt(operation.mediaType, `${path}.mediaType`, MAX_NOTE_MUTATION_META_TEXT);
    if (invalid) return invalid;
    return typeof operation.byteSize === 'number' && Number.isSafeInteger(operation.byteSize) && operation.byteSize >= 0
      ? null
      : `${path}.byteSize must be a non-negative integer.`;
  }
  return 'operation.type is not a supported Notes mutation.';
}

/** Validate and narrow an untrusted HTTP/IPC value into the shared contract. */
export function parseNotesMutationRequest(value: unknown): NotesMutationParseResult {
  const request = record(value);
  if (!request) return { ok: false, error: { path: '$', detail: 'The mutation request must be an object.' } };
  if (request.version !== NOTES_EDITING_CONTRACT_VERSION) {
    return {
      ok: false,
      error: {
        path: 'version',
        detail: `version must be ${NOTES_EDITING_CONTRACT_VERSION}.`,
      },
    };
  }
  const requestInvalid = tokenAt(request.requestId, 'requestId', MAX_NOTE_MUTATION_REQUEST_ID);
  if (requestInvalid) return { ok: false, error: { path: 'requestId', detail: requestInvalid } };
  const deviceInvalid = tokenAt(request.deviceId, 'deviceId', MAX_NOTE_MUTATION_DEVICE_ID);
  if (deviceInvalid) return { ok: false, error: { path: 'deviceId', detail: deviceInvalid } };
  const operation = record(request.operation);
  if (!operation) {
    return { ok: false, error: { path: 'operation', detail: 'operation must be an object.' } };
  }
  const invalid = validateOperation(operation);
  if (invalid) return { ok: false, error: { path: 'operation', detail: invalid } };
  return {
    ok: true,
    value: {
      version: NOTES_EDITING_CONTRACT_VERSION,
      requestId: request.requestId as string,
      deviceId: request.deviceId as string,
      operation: normalizeOwnData(operation) as NotesMutationOperation,
    },
  };
}
