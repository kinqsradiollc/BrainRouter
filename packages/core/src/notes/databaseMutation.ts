/**
 * ADR-038 — pure database mutation policy for every Notes host.
 *
 * Rows are blocks and schemas/views are fields on the database block. These
 * functions decide the exact field patch; local `databaseOps` and the remote
 * mutation endpoint then send that patch through their existing store/sync
 * writer. No function here reads or persists state.
 */
import { isLiveBlock, NOTES_MODE, type NoteBlock } from './block.js';
import {
  coerceRowValue, defaultDatabaseSchema, isDatabaseBlock, readDatabase, schemaIndex,
  TITLE_PROPERTY_ID, type NoteDatabase,
} from './database.js';
import {
  isNoteViewKind, MAX_DATABASE_VIEWS,
  type NoteDatabaseView, type NoteViewKind,
} from './databaseView.js';
import type {
  NoteMutationBlockFields, NoteMutationPropertyInput, NoteMutationPropertyPatch,
  NoteMutationViewInput,
} from './editingContract.js';
import { MAX_FORMULA_LENGTH } from './formula/value.js';
import {
  isNotePropertyType, MAX_DATABASE_PROPERTIES,
  type NotePropertyDef, type NotePropertyValue,
} from './properties.js';
import { parseWorkspaceRef } from '../workspace/references/ref.js';

export type DatabaseMutationFailure = {
  ok: false;
  reason: 'not_found' | 'not_a_database' | 'refused';
  detail: string;
};

export type DatabaseMutationPlan<T> =
  | { ok: true; patch: NoteMutationBlockFields; value: T }
  | DatabaseMutationFailure;

export type RollupTargetPropertiesResult =
  | {
      ok: true;
      value: {
        properties: NotePropertyDef[];
        databases: Array<{ id: string; title: string }>;
      };
    }
  | DatabaseMutationFailure;

const refuse = (
  reason: DatabaseMutationFailure['reason'],
  detail: string,
): DatabaseMutationFailure => ({ ok: false, reason, detail });

function databaseAt(block: NoteBlock | null | undefined, id: string): NoteDatabase | DatabaseMutationFailure {
  if (!block || !isLiveBlock(block)) return refuse('not_found', `There is no database ${id}.`);
  if (!isDatabaseBlock(block)) return refuse('not_a_database', `Block ${id} is not a database.`);
  return readDatabase(block);
}

function isFailure(value: NoteDatabase | DatabaseMutationFailure): value is DatabaseMutationFailure {
  return 'ok' in value && value.ok === false;
}

function schemaPatch(
  database: NoteDatabase,
  schema: readonly NotePropertyDef[],
): DatabaseMutationPlan<NotePropertyDef[]> {
  if (schema.length > MAX_DATABASE_PROPERTIES) {
    return refuse('refused', `A database holds at most ${MAX_DATABASE_PROPERTIES} properties.`);
  }
  const known = new Set(schema.map((def) => def.id));
  const views = database.views.map(({ groupBy, ...view }) => ({
    ...view,
    visible: view.visible.filter((id) => known.has(id)),
    ...(groupBy && known.has(groupBy) ? { groupBy } : {}),
  }));
  return { ok: true, patch: { schema, views }, value: [...schema] };
}

/** Stable, readable property id with collision handling. */
export function propertyIdFor(name: string, taken: ReadonlySet<string>, fallback = 'property'): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  let n = 1000;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function planAddDatabaseProperty(
  block: NoteBlock | null | undefined,
  databaseId: string,
  input: NoteMutationPropertyInput,
): DatabaseMutationPlan<NotePropertyDef> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  if (!isNotePropertyType(input.type)) return refuse('refused', `"${input.type}" is not a property type.`);
  if (input.type === 'title' && found.schema.some((def) => def.type === 'title')) {
    return refuse('refused', 'A database has one title column, and it is the row page’s own title.');
  }
  const taken = new Set(found.schema.map((def) => def.id));
  const id = input.id && !taken.has(input.id) ? input.id : propertyIdFor(input.name, taken);
  const def: NotePropertyDef = {
    id,
    name: input.name.trim() || id,
    type: input.type,
    ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.formula === 'string'
      ? { formula: input.formula.slice(0, MAX_FORMULA_LENGTH) }
      : {}),
    ...(input.rollup ? { rollup: input.rollup } : {}),
  };
  const schema = [...found.schema, def];
  if (schema.length > MAX_DATABASE_PROPERTIES) {
    return refuse('refused', `A database holds at most ${MAX_DATABASE_PROPERTIES} properties.`);
  }
  // A new column is visible in every existing view immediately.
  const views = found.views.map((view) => ({
    ...view,
    visible: view.visible.includes(id) ? view.visible : [...view.visible, id],
  }));
  return { ok: true, patch: { schema, views }, value: def };
}

export function planUpdateDatabaseProperty(
  block: NoteBlock | null | undefined,
  databaseId: string,
  propertyId: string,
  patch: NoteMutationPropertyPatch,
): DatabaseMutationPlan<NotePropertyDef> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  const existing = schemaIndex(found.schema).get(propertyId);
  if (!existing) return refuse('not_found', `There is no property "${propertyId}" in this database.`);
  const next: NotePropertyDef = {
    ...existing,
    ...(patch.name !== undefined && patch.name.trim().length > 0 ? { name: patch.name.trim() } : {}),
    ...(patch.options !== undefined ? { options: patch.options } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.formula !== undefined ? { formula: patch.formula.slice(0, MAX_FORMULA_LENGTH) } : {}),
    ...(patch.rollup !== undefined ? { rollup: patch.rollup } : {}),
  };
  const planned = schemaPatch(found, found.schema.map((def) => (def.id === propertyId ? next : def)));
  return planned.ok ? { ...planned, value: next } : planned;
}

export function planDeleteDatabaseProperty(
  block: NoteBlock | null | undefined,
  databaseId: string,
  propertyId: string,
): DatabaseMutationPlan<NotePropertyDef[]> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  const existing = schemaIndex(found.schema).get(propertyId);
  if (!existing) return refuse('not_found', `There is no property "${propertyId}" in this database.`);
  if (existing.type === 'title') {
    return refuse('refused', 'The title column is the row’s own title and cannot be removed.');
  }
  const schema = found.schema.filter((def) => def.id !== propertyId);
  return schemaPatch(found, schema.length > 0 ? schema : defaultDatabaseSchema());
}

export function planReorderDatabaseProperties(
  block: NoteBlock | null | undefined,
  databaseId: string,
  order: readonly string[],
): DatabaseMutationPlan<NotePropertyDef[]> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  const byId = schemaIndex(found.schema);
  const moved: NotePropertyDef[] = [];
  for (const id of order) {
    const def = byId.get(id);
    if (def && !moved.includes(def)) moved.push(def);
  }
  for (const def of found.schema) if (!moved.includes(def)) moved.push(def);
  return schemaPatch(found, moved);
}

export function planCreateDatabaseRow(
  block: NoteBlock | null | undefined,
  databaseId: string,
  input: { title?: string; values?: Record<string, unknown> },
): DatabaseMutationPlan<NoteMutationBlockFields> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  const props: Record<string, NotePropertyValue> = {};
  for (const [propertyId, raw] of Object.entries(input.values ?? {})) {
    const coerced = coerceRowValue(found, propertyId, raw);
    if (!coerced.ok) return refuse('refused', coerced.detail);
    if (coerced.def.type !== 'title') props[propertyId] = coerced.value;
  }
  const titleProperty = found.schema.find((def) => def.type === 'title');
  const titleValue = input.values?.[titleProperty?.id ?? TITLE_PROPERTY_ID];
  const title = input.title ?? (typeof titleValue === 'string' ? titleValue : '');
  const fields: NoteMutationBlockFields = {
    kind: 'page',
    text: title,
    ...(Object.keys(props).length > 0 ? { props } : {}),
  };
  return { ok: true, patch: fields, value: fields };
}

export function planSetDatabaseRowValue(
  databaseBlock: NoteBlock | null | undefined,
  databaseId: string,
  row: NoteBlock | null | undefined,
  propertyId: string,
  raw: unknown,
): DatabaseMutationPlan<NoteMutationBlockFields> {
  if (!row || !isLiveBlock(row)) return refuse('not_found', 'There is no such database row.');
  if (row.parentId.value !== databaseId) {
    return refuse('not_a_database', 'That block is not a row of this database.');
  }
  const found = databaseAt(databaseBlock, databaseId);
  if (isFailure(found)) return found;
  const coerced = coerceRowValue(found, propertyId, raw);
  if (!coerced.ok) return refuse('refused', coerced.detail);
  const patch: NoteMutationBlockFields = coerced.def.type === 'title'
    ? { text: typeof coerced.value === 'string' ? coerced.value : '' }
    : { props: { [propertyId]: coerced.value } };
  return { ok: true, patch, value: patch };
}

function defaultViewName(kind: NoteViewKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function planSaveDatabaseView(
  block: NoteBlock | null | undefined,
  databaseId: string,
  input: NoteMutationViewInput,
): DatabaseMutationPlan<NoteDatabaseView> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  const existing = input.id ? found.views.find((view) => view.id === input.id) : undefined;
  if (!existing && found.views.length >= MAX_DATABASE_VIEWS) {
    return refuse('refused', `A database holds at most ${MAX_DATABASE_VIEWS} views.`);
  }
  const kind = isNoteViewKind(input.kind) ? input.kind : existing?.kind ?? 'table';
  const known = new Set(found.schema.map((def) => def.id));
  const visible = (input.visible ?? existing?.visible ?? found.schema.map((def) => def.id))
    .filter((id) => known.has(id));
  const groupBy = input.groupBy === null
    ? undefined
    : input.groupBy !== undefined
      ? (known.has(input.groupBy) ? input.groupBy : undefined)
      : existing?.groupBy;
  const id = existing?.id
    ?? input.id
    ?? propertyIdFor(input.name ?? kind, new Set(found.views.map((view) => view.id)), 'view');
  const view: NoteDatabaseView = {
    id,
    name: input.name?.trim() || existing?.name || defaultViewName(kind),
    kind,
    visible: visible.length > 0 ? visible : found.schema.map((def) => def.id),
    ...(input.filter === null
      ? {}
      : input.filter !== undefined
        ? { filter: input.filter }
        : existing?.filter
          ? { filter: existing.filter }
          : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : existing?.sort ? { sort: existing.sort } : {}),
    ...(groupBy ? { groupBy } : {}),
  };
  const views = existing
    ? found.views.map((candidate) => (candidate.id === view.id ? view : candidate))
    : [...found.views, view];
  return { ok: true, patch: { views }, value: view };
}

export function planDeleteDatabaseView(
  block: NoteBlock | null | undefined,
  databaseId: string,
  viewId: string,
): DatabaseMutationPlan<NoteDatabaseView[]> {
  const found = databaseAt(block, databaseId);
  if (isFailure(found)) return found;
  if (found.views.length <= 1) return refuse('refused', 'A database keeps at least one view.');
  const views = found.views.filter((view) => view.id !== viewId);
  if (views.length === found.views.length) {
    return refuse('not_found', `There is no view "${viewId}" on this database.`);
  }
  return { ok: true, patch: { views }, value: views };
}

/**
 * Properties a rollup may target, derived from the rows the relation reaches.
 *
 * Blocks are supplied by the host so local-file and authenticated server reads
 * execute this one traversal without this browser-safe module owning storage.
 */
export function rollupTargetPropertiesFromBlocks(
  blocks: Iterable<NoteBlock>,
  databaseId: string,
  relationPropertyId: string,
): RollupTargetPropertiesResult {
  const all = [...blocks];
  const found = databaseAt(all.find((block) => block.id === databaseId), databaseId);
  if (isFailure(found)) return found;
  const relation = schemaIndex(found.schema).get(relationPropertyId);
  if (!relation) {
    return refuse('not_found', `There is no property "${relationPropertyId}" in this database.`);
  }
  if (relation.type !== 'relation') {
    return refuse('refused', `“${relation.name}” is not a relation property.`);
  }

  const byId = new Map(all.map((block) => [block.id, block] as const));
  const rows = all.filter((block) => (
    isLiveBlock(block) && block.parentId.value === databaseId
  ));
  const properties = new Map<string, NotePropertyDef>();
  const databases = new Map<string, string>();
  for (const row of rows) {
    const stored = row.props?.[relationPropertyId]?.value;
    const uris = Array.isArray(stored)
      ? stored
      : typeof stored === 'string' && stored ? [stored] : [];
    for (const uri of uris) {
      const parsed = parseWorkspaceRef(String(uri));
      if (!parsed.ok || parsed.ref.mode !== NOTES_MODE) continue;
      const target = byId.get(parsed.ref.id);
      if (!target || !isLiveBlock(target)) continue;
      const ownerId = target.parentId.value;
      const owner = ownerId ? byId.get(ownerId) : undefined;
      if (!owner || !isLiveBlock(owner) || !isDatabaseBlock(owner)) continue;
      const targetDatabase = readDatabase(owner);
      databases.set(owner.id, targetDatabase.title);
      for (const def of targetDatabase.schema) {
        if (!properties.has(def.id)) properties.set(def.id, def);
      }
    }
  }

  return {
    ok: true,
    value: {
      properties: [...properties.values()],
      databases: [...databases].map(([id, title]) => ({ id, title })),
    },
  };
}
